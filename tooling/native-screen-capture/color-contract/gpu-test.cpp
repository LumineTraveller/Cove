// Explicit synthetic GPU entry point. Never queries or captures a display.
// It runs both production NV12 shader matrices against fixed raw Y/UV goldens.
#define main native_helper_main_unused
#include "../../../apps/desktop/electron/native-screen-capture-helper.cpp"
#undef main
#include "reference.h"

static void completeColorTest(ID3D11Device* device, ID3D11DeviceContext* context) {
  ComPtr<ID3D11Query> query;
  const D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT, 0};
  check(device->CreateQuery(&desc, query.GetAddressOf()), "color_test_query_failed");
  context->End(query.Get()); context->Flush();
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT result = context->GetData(query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) break;
    require(result == S_FALSE && GetTickCount64() < deadline, "color_test_completion_failed");
    Sleep(1);
  }
  check(device->GetDeviceRemovedReason(), "color_test_device_lost");
}
static void copyColorTest(ID3D11DeviceContext* context, Slot& slot, Size target) {
  D3D11_MAPPED_SUBRESOURCE mapped{};
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT result = context->Map(slot.staging.Get(), 0, D3D11_MAP_READ,
      D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    if (result == S_OK) break;
    require(result == DXGI_ERROR_WAS_STILL_DRAWING && GetTickCount64() < deadline, "color_test_map_failed");
    Sleep(1);
  }
  try { copyNv12Rows(mapped, target, slot.cpuView.value, slot.cpuView.byteLength); }
  catch (...) { context->Unmap(slot.staging.Get(), 0); throw; }
  context->Unmap(slot.staging.Get(), 0);
}
static void expectColorSample(unsigned actual, unsigned expected, const char* matrix,
    const char* color, const char* plane) {
  if (actual == expected) return;
  // Only fixed synthetic inputs and byte values are printed; no desktop pixels.
  std::cerr << "{\"type\":\"color-contract-mismatch\",\"colorSpace\":\"" << matrix
    << "\",\"color\":\"" << color << "\",\"plane\":\"" << plane
    << "\",\"actual\":" << actual << ",\"expected\":" << expected << "}\n";
  throw Failure("color_test_pixel_mismatch");
}
static unsigned runColorCase(ID3D11Device* device, ID3D11DeviceContext* context,
    Nv12ColorSpace colorSpace, Size source) {
  const Size target{16,4};
  const auto matrix = colorSpace == Nv12ColorSpace::Bt601Limited ?
    color_contract::Matrix::Bt601 : color_contract::Matrix::Bt709;
  Pipeline pipeline(device, source, target, true, colorSpace);
  Slot slot; createSlot(device, slot, target, true, true);
  std::vector<unsigned char> sourceBytes(size_t(source.width) * source.height * 4);
  for (UINT y = 0; y < source.height; ++y) for (UINT x = 0; x < source.width; ++x) {
    const auto& color = color_contract::kFlatColors[x * 8 / source.width];
    const size_t offset = (size_t(y) * source.width + x) * 4;
    sourceBytes[offset] = color.rgb[2]; sourceBytes[offset + 1] = color.rgb[1];
    sourceBytes[offset + 2] = color.rgb[0]; sourceBytes[offset + 3] = 255;
  }
  context->UpdateSubresource(pipeline.desktop.Get(), 0, nullptr, sourceBytes.data(), source.width * 4, 0);
  pipeline.drawNv12(context, slot.target.Get(), slot.chromaTarget.Get());
  context->CopyResource(slot.staging.Get(), slot.texture.Get());
  completeColorTest(device, context); copyColorTest(context, slot, target);
  unsigned samples = 0;
  for (UINT y = 0; y < target.height; ++y) for (UINT x = 0; x < target.width; ++x) {
    const auto& color = color_contract::kFlatColors[x / 2];
    const auto& golden = color_contract::expected(color, matrix);
    expectColorSample(slot.cpuView.value[size_t(y) * target.width + x], golden[0],
      nv12ColorSpaceName(colorSpace), color.name, "Y");
    ++samples;
  }
  const size_t uvOffset = size_t(target.width) * target.height;
  for (UINT y = 0; y < target.height / 2; ++y) for (UINT x = 0; x < target.width; x += 2) {
    const auto& color = color_contract::kFlatColors[x / 2];
    const auto& golden = color_contract::expected(color, matrix);
    const size_t offset = uvOffset + size_t(y) * target.width + x;
    expectColorSample(slot.cpuView.value[offset], golden[1], nv12ColorSpaceName(colorSpace), color.name, "U");
    expectColorSample(slot.cpuView.value[offset + 1], golden[2], nv12ColorSpaceName(colorSpace), color.name, "V");
    samples += 2;
  }
  return samples;
}
int main(int argc, char** argv) {
  try {
    require(argc == 1 || (argc == 3 && std::string(argv[1]) == "--color-space"), "invalid_arguments");
    const std::string selection = argc == 1 ? "both" : argv[2];
    require(selection == "both" || selection == "bt601-limited" || selection == "bt709-limited", "invalid_arguments");
    ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_0};
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, 1, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "color_test_hardware_unavailable");
    for (const auto colorSpace : {Nv12ColorSpace::Bt601Limited, Nv12ColorSpace::Bt709Limited}) {
      if (selection != "both" && selection != nv12ColorSpaceName(colorSpace)) continue;
      unsigned samples = 0;
      for (const Size source : {Size{16,4}, Size{32,8}})
        samples += runColorCase(device.Get(), context.Get(), colorSpace, source);
      std::cout << "{\"type\":\"color-contract-gpu\",\"passed\":true,\"syntheticOnly\":true,\"colorSpace\":\""
        << nv12ColorSpaceName(colorSpace) << "\",\"frames\":2,\"samples\":" << samples << ",\"maxError\":0}\n";
    }
    return 0;
  } catch (const Failure& error) {
    std::cout << "{\"type\":\"error\",\"code\":\"" << error.what() << "\"}\n";
    return 2;
  } catch (...) {
    std::cout << "{\"type\":\"error\",\"code\":\"internal_failure\"}\n";
    return 2;
  }
}
