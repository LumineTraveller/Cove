// Runtime-only synthetic GPU test. No output/display/duplication/capture calls.
#define main native_helper_main_unused
#include "../../../apps/desktop/electron/native-screen-capture-helper.cpp"
#undef main
#include <d3d11_1.h>
#include <iomanip>
#include <memory>

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
// The fence matrix exercises the production completion object itself, including
// its real event wait and input pump. Run it from a parent with stdin kept open
// as an anonymous pipe (run-completion.cjs does this), not a console handle.
class ProductionTestCompletion {
  ID3D11DeviceContext* context_;
  Handle owner_;
  Clock clock_;
  CaptureTiming timing_;
  Timer timer_;
  Input input_;
  std::array<Slot, 3> emptyLeases_;
  GpuCompletion completion_;
public:
  ProductionTestCompletion(ID3D11Device* device, ID3D11DeviceContext* context)
      : context_(context), owner_(OpenProcess(SYNCHRONIZE, FALSE, GetCurrentProcessId())),
        completion_(device, context, CompletionMode::Fence) {
    require(owner_.value && ownerAlive(owner_.value), "test_owner_handle_failed");
    timing_.enabled = true; timing_.selectedCompletion = CompletionMode::Fence;
  }
  void complete() {
    require(completion_.complete(owner_.value, timer_, input_, emptyLeases_, clock_, timing_), "test_cancelled");
  }
  bool map(ID3D11Texture2D* texture, D3D11_MAPPED_SUBRESOURCE& mapped, CpuMapProgress& progress) {
    // The deadline and mapper share this exact Clock origin and input/owner.
    return mapCpuReadback(context_, texture, completion_.deadline(), owner_.value,
      timer_, input_, emptyLeases_, clock_, timing_, mapped, &progress);
  }
};
class TestCompletion {
  ID3D11Device* device_;
  ID3D11DeviceContext* context_;
  CompletionMode mode_;
  std::unique_ptr<ProductionTestCompletion> production_;
  uint64_t barriers_ = 0;
  uint64_t mapCalls_ = 0, mapAttempts_ = 0, mapStillDrawing_ = 0, mapWaitUs_ = 0;
  void accountMap(const CpuMapProgress& progress) {
    ++mapCalls_; mapAttempts_ += progress.attempts; mapStillDrawing_ += progress.stillDrawing;
    mapWaitUs_ += progress.elapsedUs;
  }
public:
  TestCompletion(ID3D11Device* device, ID3D11DeviceContext* context, CompletionMode mode)
      : device_(device), context_(context), mode_(mode) {
    if (mode_ == CompletionMode::Fence) production_ = std::make_unique<ProductionTestCompletion>(device, context);
  }
  void complete() {
    if (production_) production_->complete(); else completed(device_, context_);
    ++barriers_;
  }
  const char* name() const { return completionName(mode_); }
  uint64_t barriers() const { return barriers_; }
  UINT mapFlags() const { return mode_ == CompletionMode::Fence ? D3D11_MAP_FLAG_DO_NOT_WAIT : 0; }
  bool map(ID3D11DeviceContext* context, ID3D11Texture2D* texture, UINT flags,
      D3D11_MAPPED_SUBRESOURCE& mapped, CpuMapProgress& progress) {
    require(context == context_, "test_completion_context_mismatch"); progress = {};
    try {
      bool ready = false;
      if (production_) {
        require(flags == D3D11_MAP_FLAG_DO_NOT_WAIT, "test_blocking_map_disallowed");
        ready = production_->map(texture, mapped, progress);
      } else {
        // Keep the prior independent-query/single-Map path as a control.
        progress.attempts = 1; progress.lastResult = context->Map(texture, 0, D3D11_MAP_READ, flags, &mapped);
        check(progress.lastResult, "test_map_failed"); ready = true;
      }
      accountMap(progress); return ready;
    } catch (...) { accountMap(progress); throw; }
  }
  uint64_t mapCalls() const { return mapCalls_; }
  uint64_t mapAttempts() const { return mapAttempts_; }
  uint64_t mapStillDrawing() const { return mapStillDrawing_; }
  uint64_t mapWaitUs() const { return mapWaitUs_; }
};
static D3D11_MAPPED_SUBRESOURCE mapForTest(ID3D11DeviceContext* context, ID3D11Texture2D* texture,
    UINT flags, const char* caseName, const char* stage, const char* contextRole,
    TestCompletion& completion, UINT cycle, UINT slot) {
  D3D11_MAPPED_SUBRESOURCE mapped{};
  CpuMapProgress progress;
  try {
    require(completion.map(context, texture, flags, mapped, progress), "test_cancelled");
  } catch (const Failure& failure) {
    const HRESULT result = progress.lastResult;
    // Fixed synthetic metadata and numeric failures only; the production mapper
    // was used directly, with no blocking Map or independent query substitute.
    D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
    ComPtr<ID3D11Device> contextDevice, textureDevice;
    context->GetDevice(contextDevice.GetAddressOf()); texture->GetDevice(textureDevice.GetAddressOf());
    ComPtr<IUnknown> contextIdentity, textureIdentity;
    check(contextDevice.As(&contextIdentity), "test_context_identity_failed");
    check(textureDevice.As(&textureIdentity), "test_texture_identity_failed");
    const HRESULT removed = contextDevice->GetDeviceRemovedReason();
    std::ostringstream out;
    out << "{\"type\":\"map-failure\",\"schemaVersion\":1,\"case\":\"" << caseName
      << "\",\"stage\":\"" << stage << "\",\"contextRole\":\"" << contextRole
      << "\",\"selectedCompletion\":\"" << completion.name() << "\",\"completedBarriers\":" << completion.barriers()
      << ",\"cycle\":" << cycle << ",\"slot\":" << slot << ",\"subresource\":0,\"mapType\":" << UINT(D3D11_MAP_READ)
      << ",\"mapFlags\":" << flags << ",\"hresultUnsigned\":" << uint32_t(result)
      << ",\"mapAttempts\":" << progress.attempts << ",\"mapStillDrawing\":" << progress.stillDrawing
      << ",\"cpuMapWaitUs\":" << progress.elapsedUs << ",\"mapCancelled\":" << (progress.cancelled ? "true" : "false")
      << ",\"mapTimedOut\":" << (progress.timedOut ? "true" : "false") << ",\"failureCode\":\"" << failure.what() << '"'
      << ",\"hresultSigned\":" << int32_t(result) << ",\"hresultHex\":\"0x"
      << std::hex << std::uppercase << std::setfill('0') << std::setw(8) << uint32_t(result) << std::dec
      << "\",\"wasStillDrawing\":" << (result == DXGI_ERROR_WAS_STILL_DRAWING ? "true" : "false")
      << ",\"deviceRemovedHresultUnsigned\":" << uint32_t(removed)
      << ",\"contextType\":" << UINT(context->GetType()) << ",\"resourceDeviceMatchesContext\":"
      << (contextIdentity.Get() == textureIdentity.Get() ? "true" : "false")
      << ",\"texture\":{\"format\":" << UINT(desc.Format) << ",\"usage\":" << UINT(desc.Usage)
      << ",\"width\":" << desc.Width << ",\"height\":" << desc.Height << ",\"mipLevels\":" << desc.MipLevels
      << ",\"arraySize\":" << desc.ArraySize << ",\"sampleCount\":" << desc.SampleDesc.Count
      << ",\"cpuAccessFlags\":" << desc.CPUAccessFlags << ",\"bindFlags\":" << desc.BindFlags
      << ",\"miscFlags\":" << desc.MiscFlags << "}}" << std::endl;
    std::cout << out.str();
    throw;
  }
  return mapped;
}
class TestMutex {
  IDXGIKeyedMutex* mutex_;
  bool held_ = false;
public:
  explicit TestMutex(IDXGIKeyedMutex* mutex, bool allowNull = false) : mutex_(mutex) {
    require(mutex_ != nullptr || allowNull, "test_missing_mutex");
    if (mutex_) {
      require(mutex_->AcquireSync(0, 100) == S_OK, "test_mutex_acquire_failed"); held_ = true;
    }
  }
  TestMutex(const TestMutex&) = delete;
  void release() {
    if (!held_) return;
    held_ = false; check(mutex_->ReleaseSync(0), "test_mutex_release_failed");
  }
  ~TestMutex() { if (held_) mutex_->ReleaseSync(0); }
};
struct Case {
  enum Pattern { Epoch, GrayBars, ColorBars, ChromaChecker };
  const char* name;
  Size source, target;
  const CursorShape* shape = nullptr;
  INT cursorX = 0, cursorY = 0;
  Pattern pattern = Epoch;
};
struct Result {
  UINT error = 0, conversionError = 0;
  uint64_t pixels = 0, values = 0, frames = 0, ySamples = 0, uvSamples = 0;
  void add(const Result& other) {
    error = std::max(error, other.error); conversionError = std::max(conversionError, other.conversionError);
    pixels += other.pixels; values += other.values; frames += other.frames;
    ySamples += other.ySamples; uvSamples += other.uvSamples;
  }
};
static Pixel samplePixel(const Case& test, UINT x, UINT y, UINT epoch) {
  static constexpr Pixel bars[]{
    {{0,0,0,255}}, {{255,255,255,255}}, {{0,0,255,255}}, {{0,255,0,255}},
    {{255,0,0,255}}, {{255,255,0,255}}, {{255,0,255,255}}, {{0,255,255,255}}
  };
  static constexpr unsigned char grays[]{0,16,32,64,128,192,235,255};
  if (test.pattern == Case::GrayBars) {
    const double value = grays[(x * 8 / test.source.width + epoch) % 8];
    return {value,value,value,255};
  }
  if (test.pattern == Case::ColorBars) return bars[(x * 8 / test.source.width + epoch) % 8];
  if (test.pattern == Case::ChromaChecker) {
    static constexpr Pixel checker[]{
      {{0,0,255,255}}, {{0,255,0,255}}, {{255,0,0,255}}, {{255,255,255,255}}
    };
    return checker[(((y + epoch / 2) % 2) * 2 + (x + epoch) % 2)];
  }
  return {double((x * 29 + y * 7 + epoch * 31) % 256),
    double((x * 3 + y * 37 + epoch * 17) % 256),
    double(((x + y) % 2) * 255), double((x * 13 + y * 19 + epoch * 11) % 256)};
}
static Result runCase(const Case& test, ID3D11Device* device, ID3D11DeviceContext* context,
    ID3D11Device* readerDevice, ID3D11DeviceContext* readerContext,
    TestCompletion& writerCompletion, TestCompletion& readerCompletion) {
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
        const Pixel pixel = samplePixel(test, x, y, epoch);
        const size_t offset = size_t(y) * test.source.width + x;
        for (UINT c = 0; c < 4; ++c) bytes[offset * 4 + c] = static_cast<unsigned char>(pixel[c]);
        source[offset] = test.shape ? cursorReference(pixel, *test.shape,
          INT(x) - test.cursorX, INT(y) - test.cursorY) : pixel;
      }
      expected[index] = areaReference(source, test.source, test.target);
      TestMutex lock(slot.mutex.Get());
      context->UpdateSubresource(pipeline.desktop.Get(), 0, nullptr, bytes.data(), test.source.width * 4, 0);
      pipeline.draw(context, slot.target.Get());
      writerCompletion.complete();
      lock.release();
      slot.lease.issue(epoch + 1); slot.lease.import(epoch + 1);
      SecureZeroMemory(bytes.data(), bytes.size());
      SecureZeroMemory(source.data(), source.size() * sizeof(Pixel));
    }
    for (UINT index = 0; index < 3; ++index) {
      auto& slot = slots[index];
      require(slot.lease.busy && slot.lease.imported, "test_missing_slot_credit");
      TestMutex lock(readerMutex[index].Get());
      readerContext->CopyResource(staging.Get(), imported[index].Get());
      readerCompletion.complete();
      const auto mapped = mapForTest(readerContext, staging.Get(), readerCompletion.mapFlags(),
        test.name, "bgra-reader-staging", "reader", readerCompletion, cycle, index);
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
      lock.release();
      slot.lease.release(slot.lease.serial); ++result.frames;
      SecureZeroMemory(expected[index].data(), expected[index].size() * sizeof(Pixel));
    }
  }
  std::cout << "{\"type\":\"case\",\"pixelFormat\":\"bgra\",\"name\":\"" << test.name << "\",\"frames\":" << result.frames
    << ",\"selectedCompletion\":\"" << writerCompletion.name() << '"'
    << ",\"pixels\":" << result.pixels << ",\"values\":" << result.values << ",\"maxChannelError\":" << result.error
    << ",\"tolerance\":2,\"passed\":" << (result.error <= 2 ? "true" : "false") << "}" << std::endl;
  require(result.error <= 2, "test_pixel_reference_mismatch");
  return result;
}
// These readbacks are confined to <=64x64 synthetic test textures. The production
// helper never maps a desktop image, its BGRA scratch, or an NV12 output slot.
static ComPtr<ID3D11Texture2D> testStaging(ID3D11Device* device, Size size, DXGI_FORMAT format) {
  require(size.width <= 64 && size.height <= 64, "test_readback_size_exceeded");
  auto desc = textureDesc(size.width, size.height, format, 0);
  desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> texture;
  check(device->CreateTexture2D(&desc, nullptr, texture.GetAddressOf()), "test_staging_failed");
  return texture;
}
class TestMap {
  ID3D11DeviceContext* context_;
  ID3D11Texture2D* texture_;
public:
  D3D11_MAPPED_SUBRESOURCE value{};
  TestMap(ID3D11DeviceContext* context, ID3D11Texture2D* texture, const char* caseName, const char* stage,
      const char* contextRole, TestCompletion& completion, UINT cycle, UINT slot) : context_(context), texture_(texture) {
    value = mapForTest(context_, texture_, D3D11_MAP_FLAG_DO_NOT_WAIT, caseName, stage, contextRole, completion, cycle, slot);
  }
  TestMap(const TestMap&) = delete;
  ~TestMap() { context_->Unmap(texture_, 0); }
};
class TestReadOnlySection {
  const unsigned char* value_ = nullptr;
public:
  TestReadOnlySection() = default;
  TestReadOnlySection(const TestReadOnlySection&) = delete;
  void open(HANDLE handle, size_t byteLength) {
    require(!value_, "test_section_already_open");
    value_ = static_cast<const unsigned char*>(MapViewOfFile(handle, FILE_MAP_READ, 0, 0, byteLength));
    require(value_ != nullptr, "test_readonly_section_map_failed");
  }
  const unsigned char* bytes() const { return value_; }
  ~TestReadOnlySection() { if (value_) UnmapViewOfFile(value_); }
};
// CPU-only lifetime check: a leased parent view must remain immutable after the
// writer mapping and owning handle leave scope, including exceptional teardown.
// No device, texture, desktop API, or GPU work participates in this check.
static bool sectionOwnerExitImmutable() {
  constexpr size_t bytes = 512;
  TestReadOnlySection normalReader;
  {
    Handle section(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, DWORD(bytes), nullptr));
    require(section.value != nullptr, "test_section_lifetime_create_failed");
    CpuMappingView writer; writer.open(section.value, bytes); normalReader.open(section.value, bytes);
    require(std::all_of(normalReader.bytes(), normalReader.bytes() + bytes,
      [](unsigned char value) { return value == 0; }), "test_section_lifetime_initialization_failed");
    std::memset(writer.value, 0x7F, bytes);
    require(std::all_of(normalReader.bytes(), normalReader.bytes() + bytes,
      [](unsigned char value) { return value == 0x7F; }), "test_section_lifetime_write_failed");
  }
  require(std::all_of(normalReader.bytes(), normalReader.bytes() + bytes,
    [](unsigned char value) { return value == 0x7F; }), "test_section_normal_exit_mutated_lease");
  TestReadOnlySection exceptionReader;
  bool unwound = false;
  try {
    Handle section(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, DWORD(bytes), nullptr));
    require(section.value != nullptr, "test_section_lifetime_create_failed");
    CpuMappingView writer; writer.open(section.value, bytes); exceptionReader.open(section.value, bytes);
    std::memset(writer.value, 0xA5, bytes);
    throw Failure("test_section_owner_unwind");
  } catch (const Failure& failure) {
    require(std::strcmp(failure.what(), "test_section_owner_unwind") == 0, "test_section_unexpected_unwind");
    unwound = true;
  }
  require(unwound && exceptionReader.bytes() &&
    std::all_of(exceptionReader.bytes(), exceptionReader.bytes() + bytes,
      [](unsigned char value) { return value == 0xA5; }), "test_section_exception_exit_mutated_lease");
  // Both independent read-only mappings remain live until this function exits.
  return true;
}
static std::array<double, 3> rec709Reference(const Pixel& bgra) {
  const double r = bgra[2] / 255.0, g = bgra[1] / 255.0, b = bgra[0] / 255.0;
  const double y = .2126 * r + .7152 * g + .0722 * b;
  return {16.0 + 219.0 * y, 128.0 + 224.0 * (b - y) / (2.0 * (1.0 - .0722)),
    128.0 + 224.0 * (r - y) / (2.0 * (1.0 - .2126))};
}
static INT quantizedByte(double value) { return INT(std::floor(std::clamp(value, 0.0, 255.0) + .5)); }
static Result runNv12Case(const Case& test, ID3D11Device* device, ID3D11DeviceContext* context,
    ID3D11Device* readerDevice, ID3D11DeviceContext* readerContext,
    TestCompletion& writerCompletion, TestCompletion& readerCompletion, bool cpu = false) {
  require(test.source.width <= 64 && test.source.height <= 64 &&
    test.target.width % 2 == 0 && test.target.height % 2 == 0, "test_nv12_geometry_invalid");
  Pipeline pipeline(device, test.source, test.target, true);
  if (test.shape) {
    pipeline.uploadCursor(device, *test.shape); pipeline.values.cursorVisible = 1;
    pipeline.values.cursorX = test.cursorX; pipeline.values.cursorY = test.cursorY;
  }
  std::array<Slot, 3> slots;
  std::array<TestReadOnlySection, 3> sections;
  std::array<ComPtr<ID3D11Texture2D>, 3> imported;
  std::array<ComPtr<IDXGIKeyedMutex>, 3> readerMutex;
  ComPtr<ID3D11Device1> reader1;
  if (!cpu) check(readerDevice->QueryInterface(IID_PPV_ARGS(reader1.GetAddressOf())), "test_device1_failed");
  const size_t sectionBytes = size_t(test.target.width) * test.target.height * 3 / 2;
  for (UINT index = 0; index < 3; ++index) {
    auto& slot = slots[index];
    createSlot(device, slot, test.target, true, cpu);
    if (cpu) {
      D3D11_TEXTURE2D_DESC actual{}, staging{};
      slot.texture->GetDesc(&actual);
      require(slot.staging.Get() != nullptr, "test_missing_cpu_staging"); slot.staging->GetDesc(&staging);
      require(actual.Format == DXGI_FORMAT_NV12 && actual.Width == test.target.width &&
        actual.Height == test.target.height && actual.Usage == D3D11_USAGE_DEFAULT &&
        actual.CPUAccessFlags == 0 && actual.MiscFlags == 0 &&
        slot.mutex.Get() == nullptr && staging.Format == DXGI_FORMAT_NV12 &&
        staging.Width == test.target.width && staging.Height == test.target.height &&
        staging.Usage == D3D11_USAGE_STAGING && staging.CPUAccessFlags == D3D11_CPU_ACCESS_READ &&
        staging.MiscFlags == 0 && staging.BindFlags == 0, "test_cpu_texture_storage_mismatch");
      require(slot.cpuView.value && slot.cpuView.byteLength == sectionBytes, "test_cpu_section_length_mismatch");
      DWORD handleFlags = 0;
      require(GetHandleInformation(slot.local.value, &handleFlags) && !(handleFlags & HANDLE_FLAG_INHERIT),
        "test_cpu_section_inheritable");
      sections[index].open(slot.local.value, sectionBytes);
      const auto* writerBytes = static_cast<const unsigned char*>(slot.cpuView.value);
      for (size_t offset = 0; offset < sectionBytes; ++offset)
        require(writerBytes[offset] == 0 && sections[index].bytes()[offset] == 0, "test_cpu_section_not_zero_initialized");
      continue;
    }
    check(reader1->OpenSharedResource1(slots[index].local.value, IID_PPV_ARGS(imported[index].GetAddressOf())),
      "test_shared_nt_open_failed");
    D3D11_TEXTURE2D_DESC actual{}; imported[index]->GetDesc(&actual);
    require(actual.Format == DXGI_FORMAT_NV12 && actual.Width == test.target.width &&
      actual.Height == test.target.height, "test_imported_nv12_geometry_mismatch");
    check(imported[index].As(&readerMutex[index]), "test_shared_mutex_open_failed");
  }
  auto scratchStaging = testStaging(device, test.target, DXGI_FORMAT_B8G8R8A8_UNORM);
  ComPtr<ID3D11Texture2D> nv12Staging;
  if (!cpu) nv12Staging = testStaging(readerDevice, test.target, DXGI_FORMAT_NV12);
  std::array<std::vector<Pixel>, 3> actualScratch;
  Result result;
  for (UINT cycle = 0; cycle < 3; ++cycle) {
    for (UINT index = 0; index < 3; ++index) {
      auto& slot = slots[index];
      require(!slot.lease.busy, "test_busy_slot_selected");
      const UINT epoch = cycle * 3 + index;
      std::vector<unsigned char> bytes(size_t(test.source.width) * test.source.height * 4);
      std::vector<Pixel> source(size_t(test.source.width) * test.source.height);
      for (UINT y = 0; y < test.source.height; ++y) for (UINT x = 0; x < test.source.width; ++x) {
        const Pixel pixel = samplePixel(test, x, y, epoch);
        const size_t offset = size_t(y) * test.source.width + x;
        for (UINT channel = 0; channel < 4; ++channel) bytes[offset * 4 + channel] = static_cast<unsigned char>(pixel[channel]);
        source[offset] = test.shape ? cursorReference(pixel, *test.shape,
          INT(x) - test.cursorX, INT(y) - test.cursorY) : pixel;
      }
      auto expected = areaReference(source, test.source, test.target);
      TestMutex lock(slot.mutex.Get(), cpu);
      context->UpdateSubresource(pipeline.desktop.Get(), 0, nullptr, bytes.data(), test.source.width * 4, 0);
      pipeline.drawNv12(context, slot.target.Get(), slot.chromaTarget.Get());
      require(pipeline.nv12Scratch() != nullptr, "test_missing_nv12_scratch");
      if (cpu) context->CopyResource(slot.staging.Get(), slot.texture.Get());
      context->CopyResource(scratchStaging.Get(), pipeline.nv12Scratch());
      // GPU slots stay locked through this barrier. CPU slots have no shared GPU
      // resource: their staging copy also completes before any Map/section write.
      writerCompletion.complete();
      if (cpu) {
        TestMap mapped(context, slot.staging.Get(), test.name, "cpu-nv12-staging", "writer", writerCompletion, cycle, index);
        copyNv12Rows(mapped.value, test.target, static_cast<unsigned char*>(slot.cpuView.value), slot.cpuView.byteLength);
        require(std::memcmp(slot.cpuView.value, sections[index].bytes(), sectionBytes) == 0,
          "test_cpu_readonly_section_mismatch");
      }
      {
        TestMap mapped(context, scratchStaging.Get(), test.name, "bgra-scratch-staging", "writer", writerCompletion, cycle, index);
        require(mapped.value.pData && mapped.value.RowPitch >= test.target.width * 4, "test_scratch_layout_invalid");
        actualScratch[index].resize(size_t(test.target.width) * test.target.height);
        for (UINT y = 0; y < test.target.height; ++y) for (UINT x = 0; x < test.target.width; ++x) {
          const auto* actual = static_cast<const unsigned char*>(mapped.value.pData) + size_t(y) * mapped.value.RowPitch + x * 4;
          const size_t offset = size_t(y) * test.target.width + x;
          for (UINT channel = 0; channel < 4; ++channel) {
            actualScratch[index][offset][channel] = actual[channel];
            result.error = std::max(result.error, UINT(std::abs(INT(actual[channel]) - INT(std::lround(expected[offset][channel])))));
            ++result.values;
          }
        }
      }
      lock.release(); slot.lease.issue(epoch + 1); slot.lease.import(epoch + 1);
      SecureZeroMemory(bytes.data(), bytes.size()); SecureZeroMemory(source.data(), source.size() * sizeof(Pixel));
      SecureZeroMemory(expected.data(), expected.size() * sizeof(Pixel));
    }
    // Keep all three exported slots outstanding before any consumer reads them,
    // so a shared-texture/section alias or a stale plane is checked by its epoch.
    for (UINT index = 0; index < 3; ++index) {
      auto& slot = slots[index];
      require(slot.lease.busy && slot.lease.imported, "test_missing_slot_credit");
      const auto validateNv12 = [&](const unsigned char* yBytes, size_t rowPitch) {
        require(yBytes && rowPitch >= test.target.width, "test_nv12_layout_invalid");
        const auto* uvBytes = yBytes + rowPitch * test.target.height;
        for (UINT y = 0; y < test.target.height; ++y) for (UINT x = 0; x < test.target.width; ++x) {
          const auto& rgb = actualScratch[index][size_t(y) * test.target.width + x];
          const INT actual = yBytes[size_t(y) * rowPitch + x];
          require(actual >= 16 && actual <= 235, "test_nv12_luma_range_mismatch");
          if (rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0) require(actual == 16, "test_nv12_black_mismatch");
          if (rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255) require(actual == 235, "test_nv12_white_mismatch");
          result.conversionError = std::max(result.conversionError, UINT(std::abs(actual - quantizedByte(rec709Reference(rgb)[0]))));
          ++result.ySamples; ++result.values; ++result.pixels;
        }
        for (UINT y = 0; y < test.target.height / 2; ++y) for (UINT x = 0; x < test.target.width / 2; ++x) {
          Pixel average{};
          for (UINT dy = 0; dy < 2; ++dy) for (UINT dx = 0; dx < 2; ++dx) {
            const auto& rgb = actualScratch[index][size_t(y * 2 + dy) * test.target.width + x * 2 + dx];
            for (UINT channel = 0; channel < 3; ++channel) average[channel] += rgb[channel] * .25;
          }
          const auto expected = rec709Reference(average);
          for (UINT channel = 0; channel < 2; ++channel) {
            const INT actual = uvBytes[size_t(y) * rowPitch + x * 2 + channel];
            require(actual >= 16 && actual <= 240, "test_nv12_chroma_range_mismatch");
            if (average[0] == average[1] && average[1] == average[2])
              require(actual == 128, "test_nv12_neutral_chroma_mismatch");
            result.conversionError = std::max(result.conversionError, UINT(std::abs(actual - quantizedByte(expected[channel + 1]))));
            ++result.uvSamples; ++result.values;
          }
        }
      };
      if (cpu) {
        // A separately mapped FILE_MAP_READ view observes the tightly packed
        // section. No GPU import or keyed mutex participates in this transport.
        validateNv12(sections[index].bytes(), test.target.width);
      } else {
        TestMutex lock(readerMutex[index].Get());
        readerContext->CopyResource(nv12Staging.Get(), imported[index].Get()); readerCompletion.complete();
        {
          TestMap mapped(readerContext, nv12Staging.Get(), test.name, "gpu-nv12-reader-staging", "reader", readerCompletion, cycle, index);
          validateNv12(static_cast<const unsigned char*>(mapped.value.pData), mapped.value.RowPitch);
        }
        lock.release();
      }
      slot.lease.release(slot.lease.serial); ++result.frames;
      SecureZeroMemory(actualScratch[index].data(), actualScratch[index].size() * sizeof(Pixel));
    }
  }
  const bool passed = result.error <= 2 && result.conversionError <= 1;
  std::cout << "{\"type\":\"case\",\"pixelFormat\":\"nv12\",\"frameStorage\":\"" << (cpu ? "cpu" : "gpu")
    << "\",\"selectedCompletion\":\"" << writerCompletion.name()
    << "\",\"colorSpace\":\"bt709-limited\",\"name\":\"" << test.name
    << "\",\"frames\":" << result.frames << ",\"pixels\":" << result.pixels << ",\"values\":" << result.values
    << ",\"maxChannelError\":" << result.error << ",\"tolerance\":2,\"maxConversionError\":" << result.conversionError
    << ",\"conversionTolerance\":1,\"ySamples\":" << result.ySamples << ",\"uvSamples\":" << result.uvSamples
    << ",\"cpuReadOnlySection\":" << (cpu ? "true" : "false")
    << ",\"passed\":" << (passed ? "true" : "false") << "}" << std::endl;
  require(passed, "test_nv12_pixel_reference_mismatch"); return result;
}
// A real GPU-derived lease must survive destruction of the writer's staging
// texture, mapping, section handle and pipeline, on normal and exceptional exit.
static bool gpuSectionOwnerExitImmutable(ID3D11Device* device, ID3D11DeviceContext* context,
    TestCompletion& completion) {
  constexpr Size size{8,8};
  constexpr size_t byteLength = size.width * size.height * 3 / 2;
  std::array<TestReadOnlySection, 2> readers;
  std::array<std::array<unsigned char, byteLength>, 2> expected{};
  for (UINT mode = 0; mode < 2; ++mode) {
    bool unwound = false;
    try {
      Pipeline pipeline(device, size, size, true);
      Slot slot; createSlot(device, slot, size, true, true);
      readers[mode].open(slot.local.value, byteLength);
      const Pixel color = mode ? Pixel{255,0,0,255} : Pixel{0,0,255,255};
      std::array<unsigned char, size.width * size.height * 4> source{};
      for (size_t pixel = 0; pixel < size.width * size.height; ++pixel)
        for (UINT channel = 0; channel < 4; ++channel) source[pixel * 4 + channel] = static_cast<unsigned char>(color[channel]);
      context->UpdateSubresource(pipeline.desktop.Get(), 0, nullptr, source.data(), size.width * 4, 0);
      pipeline.drawNv12(context, slot.target.Get(), slot.chromaTarget.Get());
      context->CopyResource(slot.staging.Get(), slot.texture.Get());
      completion.complete();
      {
        TestMap mapped(context, slot.staging.Get(), mode ? "gpu-section-exception-exit" : "gpu-section-normal-exit",
          "cpu-nv12-staging", "writer", completion, 0, mode);
        copyNv12Rows(mapped.value, size, slot.cpuView.value, slot.cpuView.byteLength);
      }
      const auto yuv = rec709Reference(color);
      std::fill_n(expected[mode].begin(), size.width * size.height, static_cast<unsigned char>(quantizedByte(yuv[0])));
      for (size_t offset = size.width * size.height; offset < byteLength; offset += 2) {
        expected[mode][offset] = static_cast<unsigned char>(quantizedByte(yuv[1]));
        expected[mode][offset + 1] = static_cast<unsigned char>(quantizedByte(yuv[2]));
      }
      require(std::memcmp(readers[mode].bytes(), expected[mode].data(), byteLength) == 0,
        "test_gpu_section_known_color_mismatch");
      if (mode) throw Failure("test_gpu_section_owner_unwind");
    } catch (const Failure& failure) {
      if (mode != 1 || std::strcmp(failure.what(), "test_gpu_section_owner_unwind") != 0) throw;
      unwound = true;
    }
    require((mode == 0 || unwound) && std::memcmp(readers[mode].bytes(), expected[mode].data(), byteLength) == 0,
      "test_gpu_section_owner_exit_mutated_lease");
  }
  return true;
}
struct CompletionHandleCounts { DWORD baseline = 0, afterBatch1 = 0, afterBatch2 = 0; };
static CompletionHandleCounts completionHandleLifetime(ID3D11Device* device, ID3D11DeviceContext* context,
    TestCompletion& persistent) {
  const auto cycles = [&](UINT count) {
    for (UINT index = 0; index < count; ++index) {
      ProductionTestCompletion temporary(device, context); temporary.complete();
    }
    context->ClearState(); context->Flush(); persistent.complete();
  };
  const auto handleCount = [] {
    DWORD count = 0;
    require(GetProcessHandleCount(GetCurrentProcess(), &count), "test_handle_count_failed"); return count;
  };
  // Fixed warmup permits initial driver caches. Two fixed measurement batches
  // detect continued per-instance leakage without retrying until counts pass.
  cycles(16);
  CompletionHandleCounts counts; counts.baseline = handleCount();
  cycles(64); counts.afterBatch1 = handleCount();
  cycles(64); counts.afterBatch2 = handleCount();
  std::cout << "{\"type\":\"completion-handles\",\"selectedCompletion\":\"fence\",\"warmupCycles\":16"
    << ",\"cyclesPerBatch\":64,\"baseline\":" << counts.baseline << ",\"afterBatch1\":" << counts.afterBatch1
    << ",\"afterBatch2\":" << counts.afterBatch2 << ",\"noSustainedGrowth\":"
    << (counts.afterBatch2 <= counts.afterBatch1 ? "true" : "false") << "}" << std::endl;
  require(counts.afterBatch2 <= counts.afterBatch1, "test_completion_handle_growth");
  return counts;
}
int main(int argc, char** argv) {
  try {
    std::string pixelFormat = "bgra";
    CompletionMode completionMode = CompletionMode::Query;
    require(argc >= 1 && argc <= 5 && argc % 2 == 1, "test_invalid_arguments");
    unsigned seen = 0;
    for (int index = 1; index < argc; index += 2) {
      const std::string name(argv[index]), value(argv[index + 1]);
      unsigned bit = 0;
      if (name == "--pixel-format") {
        bit = 1; pixelFormat = value;
        require(pixelFormat == "bgra" || pixelFormat == "nv12" || pixelFormat == "both" || pixelFormat == "cpu-nv12",
          "test_invalid_pixel_format");
      } else if (name == "--completion") {
        bit = 2; require(value == "query" || value == "fence", "test_invalid_completion");
        completionMode = value == "fence" ? CompletionMode::Fence : CompletionMode::Query;
      } else require(false, "test_invalid_arguments");
      require(!(seen & bit), "test_invalid_arguments"); seen |= bit;
    }
    bool ownerExitImmutable = false;
    if (pixelFormat == "cpu-nv12") ownerExitImmutable = sectionOwnerExitImmutable();
    ComPtr<ID3D11Device> device, reader;
    ComPtr<ID3D11DeviceContext> context, readerContext;
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_0};
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, 1, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "test_hardware_device_failed");
    ComPtr<IDXGIDevice> dxgi; check(device.As(&dxgi), "test_dxgi_device_failed");
    ComPtr<IDXGIAdapter> adapter; check(dxgi->GetAdapter(adapter.GetAddressOf()), "test_adapter_failed");
    check(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, 1, D3D11_SDK_VERSION, reader.GetAddressOf(), nullptr, readerContext.GetAddressOf()), "test_reader_device_failed");
    TestCompletion writerCompletion(device.Get(), context.Get(), completionMode);
    TestCompletion readerCompletion(reader.Get(), readerContext.Get(), completionMode);
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
    const std::array<Case, 3> colorCases{{
      {"nv12-gray-bars",{64,32},{64,32},nullptr,0,0,Case::GrayBars},
      {"nv12-color-bars",{64,32},{64,32},nullptr,0,0,Case::ColorBars},
      {"nv12-chroma-checker",{64,32},{64,32},nullptr,0,0,Case::ChromaChecker}
    }};
    Result total;
    unsigned caseCount = 0;
    if (pixelFormat == "bgra" || pixelFormat == "both") for (const auto& test : cases) {
      total.add(runCase(test, device.Get(), context.Get(), reader.Get(), readerContext.Get(), writerCompletion, readerCompletion)); ++caseCount;
    }
    if (pixelFormat != "bgra") {
      const bool cpu = pixelFormat == "cpu-nv12";
      for (const auto& test : cases) {
        total.add(runNv12Case(test, device.Get(), context.Get(), reader.Get(), readerContext.Get(), writerCompletion, readerCompletion, cpu)); ++caseCount;
      }
      for (const auto& test : colorCases) {
        total.add(runNv12Case(test, device.Get(), context.Get(), reader.Get(), readerContext.Get(), writerCompletion, readerCompletion, cpu)); ++caseCount;
      }
    }
    bool gpuOwnerExitImmutable = false;
    if (pixelFormat == "cpu-nv12" && completionMode == CompletionMode::Fence)
      gpuOwnerExitImmutable = gpuSectionOwnerExitImmutable(device.Get(), context.Get(), writerCompletion);
    CompletionHandleCounts completionHandles;
    if (completionMode == CompletionMode::Fence)
      completionHandles = completionHandleLifetime(device.Get(), context.Get(), writerCompletion);
    context->ClearState(); context->Flush(); readerContext->ClearState(); readerContext->Flush();
    check(device->GetDeviceRemovedReason(), "test_writer_device_lost");
    check(reader->GetDeviceRemovedReason(), "test_reader_device_lost");
    std::cout << "{\"type\":\"done\",\"passed\":true,\"desktopCapture\":false,\"pixelFormat\":\"" << pixelFormat
      << "\",\"selectedCompletion\":\"" << completionName(completionMode)
      << "\",\"productionCompletion\":" << (completionMode == CompletionMode::Fence ? "true" : "false")
      << ",\"productionMapReadiness\":" << (completionMode == CompletionMode::Fence ? "true" : "false")
      << ",\"writerBarriers\":" << writerCompletion.barriers() << ",\"readerBarriers\":" << readerCompletion.barriers()
      << ",\"cpuMapCalls\":" << writerCompletion.mapCalls() + readerCompletion.mapCalls()
      << ",\"cpuMapAttempts\":" << writerCompletion.mapAttempts() + readerCompletion.mapAttempts()
      << ",\"cpuMapStillDrawing\":" << writerCompletion.mapStillDrawing() + readerCompletion.mapStillDrawing()
      << ",\"cpuMapWaitUs\":" << writerCompletion.mapWaitUs() + readerCompletion.mapWaitUs()
      << ",\"cases\":" << caseCount
      << ",\"frames\":" << total.frames << ",\"pixels\":" << total.pixels << ",\"values\":" << total.values
      << ",\"maxChannelError\":" << total.error << ",\"tolerance\":2,\"maxConversionError\":" << total.conversionError
      << ",\"conversionTolerance\":1,\"ySamples\":" << total.ySamples << ",\"uvSamples\":" << total.uvSamples
      << ",\"sharedNtReaderDevice\":" << (pixelFormat == "cpu-nv12" ? "false" : "true")
      << ",\"cpuReadOnlySection\":" << (pixelFormat == "cpu-nv12" ? "true" : "false");
    if (pixelFormat == "cpu-nv12") {
      std::cout << ",\"sectionOwnerExitImmutable\":" << (ownerExitImmutable ? "true" : "false");
      if (completionMode == CompletionMode::Fence)
        std::cout << ",\"gpuSectionOwnerExitImmutable\":" << (gpuOwnerExitImmutable ? "true" : "false");
    }
    if (completionMode == CompletionMode::Fence)
      std::cout << ",\"completionHandleCountBaseline\":" << completionHandles.baseline
        << ",\"completionHandleCountAfterBatch1\":" << completionHandles.afterBatch1
        << ",\"completionHandleCountAfterBatch2\":" << completionHandles.afterBatch2
        << ",\"completionHandleNoSustainedGrowth\":true";
    std::cout << "}" << std::endl;
    return 0;
  } catch (const Failure& error) {
    std::cout << "{\"type\":\"error\",\"code\":\"" << error.what() << "\"}" << std::endl; return 2;
  } catch (...) {
    std::cout << "{\"type\":\"error\",\"code\":\"test_internal_failure\"}" << std::endl; return 2;
  }
}
