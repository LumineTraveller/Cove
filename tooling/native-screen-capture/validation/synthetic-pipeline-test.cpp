// Runtime-only synthetic GPU test. No output/display/duplication/capture calls.
#define main native_helper_main_unused
#include "../../../apps/desktop/electron/native-screen-capture-helper.cpp"
#undef main
#include <d3d11_1.h>

static void completed(ID3D11Device* device, ID3D11DeviceContext* context) {
  ComPtr<ID3D11Query> query;
  const D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT, 0};
  check(device->CreateQuery(&desc, query.GetAddressOf()), "test_query_create_failed");
  context->End(query.Get()); context->Flush();
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT hr = context->GetData(query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (hr == S_OK) break;
    require(hr == S_FALSE && GetTickCount64() < deadline, "test_gpu_completion_failed");
    Sleep(1);
  }
  check(device->GetDeviceRemovedReason(), "test_gpu_device_lost");
}
struct Case {
  const char* name;
  Size source, target;
  const CursorShape* shape = nullptr;
  INT cursorX = 0, cursorY = 0;
};
struct Result { UINT error = 0; uint64_t pixels = 0, values = 0, frames = 0; };
static Result runCase(const Case& test, ID3D11Device* device, ID3D11DeviceContext* context,
    ID3D11Device* readerDevice, ID3D11DeviceContext* readerContext) {
  Pipeline pipeline(device, test.source, test.target);
  if (test.shape) {
    pipeline.uploadCursor(device, *test.shape);
    pipeline.values.cursorVisible = 1;
    pipeline.values.cursorX = test.cursorX; pipeline.values.cursorY = test.cursorY;
  }
  std::array<Slot, 3> slots;
  std::array<ComPtr<ID3D11Texture2D>, 3> imported;
  std::array<ComPtr<IDXGIKeyedMutex>, 3> readerMutex;
  ComPtr<ID3D11Device1> reader1; check(readerDevice->QueryInterface(IID_PPV_ARGS(reader1.GetAddressOf())), "test_device1_failed");
  for (UINT i = 0; i < 3; ++i) {
    createSlot(device, slots[i], test.target);
    check(reader1->OpenSharedResource1(slots[i].local.value, IID_PPV_ARGS(imported[i].GetAddressOf())), "test_shared_nt_open_failed");
    check(imported[i].As(&readerMutex[i]), "test_shared_mutex_open_failed");
  }
  auto stagingDesc = textureDesc(test.target.width, test.target.height, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
  stagingDesc.Usage = D3D11_USAGE_STAGING; stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  check(readerDevice->CreateTexture2D(&stagingDesc, nullptr, staging.GetAddressOf()), "test_staging_failed");
  Result result;
  std::array<std::vector<Pixel>, 3> expected;
  // Write all three slots before reading any, then acknowledge all-reference
  // release and cycle. A stale write or alias therefore fails another slot.
  for (UINT cycle = 0; cycle < 3; ++cycle) {
    for (UINT index = 0; index < 3; ++index) {
      auto& slot = slots[index];
      require(!slot.lease.busy, "test_busy_slot_selected");
      const UINT epoch = cycle * 3 + index;
      std::vector<unsigned char> bytes(size_t(test.source.width) * test.source.height * 4);
      std::vector<Pixel> source(size_t(test.source.width) * test.source.height);
      for (UINT y = 0; y < test.source.height; ++y) for (UINT x = 0; x < test.source.width; ++x) {
        const Pixel pixel{double((x * 29 + y * 7 + epoch * 31) % 256),
          double((x * 3 + y * 37 + epoch * 17) % 256),
          double(((x + y) % 2) * 255), double((x * 13 + y * 19 + epoch * 11) % 256)};
        const size_t offset = size_t(y) * test.source.width + x;
        for (UINT c = 0; c < 4; ++c) bytes[offset * 4 + c] = static_cast<unsigned char>(pixel[c]);
        source[offset] = test.shape ? cursorReference(pixel, *test.shape,
          INT(x) - test.cursorX, INT(y) - test.cursorY) : pixel;
      }
      expected[index] = areaReference(source, test.source, test.target);
      require(slot.mutex->AcquireSync(0, 100) == S_OK, "test_writer_mutex_failed");
      context->UpdateSubresource(pipeline.desktop.Get(), 0, nullptr, bytes.data(), test.source.width * 4, 0);
      pipeline.draw(context, slot.target.Get());
      completed(device, context);
      check(slot.mutex->ReleaseSync(0), "test_writer_release_failed");
      slot.lease.issue(epoch + 1); slot.lease.import(epoch + 1);
      SecureZeroMemory(bytes.data(), bytes.size());
      SecureZeroMemory(source.data(), source.size() * sizeof(Pixel));
    }
    for (UINT index = 0; index < 3; ++index) {
      auto& slot = slots[index];
      require(slot.lease.busy && slot.lease.imported, "test_missing_slot_credit");
      require(readerMutex[index]->AcquireSync(0, 100) == S_OK, "test_reader_mutex_failed");
      readerContext->CopyResource(staging.Get(), imported[index].Get());
      completed(readerDevice, readerContext);
      D3D11_MAPPED_SUBRESOURCE mapped{};
      check(readerContext->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "test_map_failed");
      require(mapped.RowPitch >= test.target.width * 4, "test_row_pitch_failed");
      for (UINT y = 0; y < test.target.height; ++y) for (UINT x = 0; x < test.target.width; ++x) {
        const auto* actual = static_cast<const unsigned char*>(mapped.pData) + size_t(y) * mapped.RowPitch + x * 4;
        const auto& reference = expected[index][size_t(y) * test.target.width + x];
        for (UINT c = 0; c < 4; ++c) {
          const UINT error = UINT(std::abs(INT(actual[c]) - INT(std::lround(reference[c]))));
          result.error = std::max(result.error, error); ++result.values;
        }
        ++result.pixels;
      }
      readerContext->Unmap(staging.Get(), 0);
      check(readerMutex[index]->ReleaseSync(0), "test_reader_release_failed");
      slot.lease.release(slot.lease.serial); ++result.frames;
      SecureZeroMemory(expected[index].data(), expected[index].size() * sizeof(Pixel));
    }
  }
  std::cout << "{\"type\":\"case\",\"name\":\"" << test.name << "\",\"frames\":" << result.frames
    << ",\"pixels\":" << result.pixels << ",\"values\":" << result.values << ",\"maxChannelError\":" << result.error
    << ",\"tolerance\":2,\"passed\":" << (result.error <= 2 ? "true" : "false") << "}" << std::endl;
  require(result.error <= 2, "test_pixel_reference_mismatch");
  return result;
}
int main() {
  try {
    ComPtr<ID3D11Device> device, reader;
    ComPtr<ID3D11DeviceContext> context, readerContext;
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_0};
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, 1, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "test_hardware_device_failed");
    ComPtr<IDXGIDevice> dxgi; check(device.As(&dxgi), "test_dxgi_device_failed");
    ComPtr<IDXGIAdapter> adapter; check(dxgi->GetAdapter(adapter.GetAddressOf()), "test_adapter_failed");
    check(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, 1, D3D11_SDK_VERSION, reader.GetAddressOf(), nullptr, readerContext.GetAddressOf()), "test_reader_device_failed");
    DXGI_OUTDUPL_POINTER_SHAPE_INFO info{}; info.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
    info.Width = 4; info.Height = 3; info.Pitch = 20; info.HotSpot = {3,2};
    const unsigned char colors[]{
      10,20,30,0, 200,100,50,128, 10,20,30,255, 230,180,90,64, 0,0,0,0,
      20,30,40,255, 210,110,60,0, 20,30,40,128, 240,190,100,255, 0,0,0,0,
      30,40,50,128, 220,120,70,255, 30,40,50,0, 250,200,110,128, 0,0,0,0};
    const auto color = decodeCursor(info, colors, sizeof(colors));
    info.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
    const unsigned char masks[]{
      10,20,30,0, 255,255,255,255, 0,0,0,255, 255,0,128,255, 0,0,0,0,
      20,30,40,0, 0,127,255,255, 20,30,40,0, 240,190,100,255, 0,0,0,0,
      30,40,50,255, 220,120,70,0, 30,40,50,0, 250,200,110,255, 0,0,0,0};
    const auto masked = decodeCursor(info, masks, sizeof(masks));
    info.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
    info.Width = 4; info.Height = 6; info.Pitch = 2;
    const unsigned char bits[]{0x30,0xCC, 0xF0,0xDD, 0xA0,0xEE, 0x50,0x11, 0xF0,0x22, 0x50,0x33};
    const auto mono = decodeCursor(info, bits, sizeof(bits));
    const std::array<Case, 16> cases{{
      {"area-half",{64,40},{32,20}}, {"area-identity",{16,10},{16,10}},
      {"area-odd-small-reduction",{63,39},{62,38}}, {"area-noninteger",{64,40},{22,14}},
      {"color-identity",{16,10},{16,10},&color,5,3}, {"color-area",{64,40},{22,14},&color,25,17},
      {"color-negative-clip",{16,10},{8,6},&color,-2,-1}, {"color-bottom-right-clip",{16,10},{8,6},&color,14,8},
      {"masked-identity",{16,10},{16,10},&masked,5,3}, {"masked-area",{64,40},{22,14},&masked,25,17},
      {"masked-negative-clip",{16,10},{8,6},&masked,-2,-1}, {"masked-bottom-right-clip",{16,10},{8,6},&masked,14,8},
      {"mono-identity",{16,10},{16,10},&mono,5,3}, {"mono-area",{64,40},{22,14},&mono,25,17},
      {"mono-negative-clip",{16,10},{8,6},&mono,-2,-1}, {"mono-bottom-right-clip",{16,10},{8,6},&mono,14,8}
    }};
    Result total;
    for (const auto& test : cases) {
      const auto result = runCase(test, device.Get(), context.Get(), reader.Get(), readerContext.Get());
      total.error = std::max(total.error, result.error); total.pixels += result.pixels;
      total.values += result.values; total.frames += result.frames;
    }
    context->ClearState(); context->Flush(); readerContext->ClearState(); readerContext->Flush();
    check(device->GetDeviceRemovedReason(), "test_writer_device_lost");
    check(reader->GetDeviceRemovedReason(), "test_reader_device_lost");
    std::cout << "{\"type\":\"done\",\"passed\":true,\"desktopCapture\":false,\"cases\":" << cases.size()
      << ",\"frames\":" << total.frames << ",\"pixels\":" << total.pixels << ",\"values\":" << total.values
      << ",\"maxChannelError\":" << total.error << ",\"tolerance\":2,\"sharedNtReaderDevice\":true}" << std::endl;
    return 0;
  } catch (const Failure& error) {
    std::cout << "{\"type\":\"error\",\"code\":\"" << error.what() << "\"}" << std::endl; return 2;
  } catch (...) {
    std::cout << "{\"type\":\"error\",\"code\":\"test_internal_failure\"}" << std::endl; return 2;
  }
}
