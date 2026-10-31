// Synthetic, standalone failure-path harness. No Node runtime, GPU or capture.
// Compile this TU with the same x64 compiler and node_api.h include directory
// as native-screen-handles.cpp, then run the resulting console executable.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

static LPVOID WINAPI testMapViewOfFile(HANDLE, DWORD, DWORD, DWORD, SIZE_T);
static BOOL WINAPI testReadProcessMemory(HANDLE, LPCVOID, LPVOID, SIZE_T, SIZE_T*);
#define MapViewOfFile testMapViewOfFile
#define ReadProcessMemory testReadProcessMemory
#undef NOMINMAX // MinGW headers normalize this macro to 1; the source defines it.
#include "../electron/native-screen-handles.cpp"
#undef ReadProcessMemory
#undef MapViewOfFile

#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {
constexpr size_t kBytes = 8192; // Page aligned so an oversized view is rejected.
enum class CopyMode { Normal, FailedPartial, SuccessfulShort };
enum class ValueKind { Owner, Buffer, Number, ArrayBuffer, Undefined };
struct MockValue {
  ValueKind kind;
  void* bytes = nullptr;
  size_t length = 0;
  double number = 0;
};
struct MockCall {
  MockValue* self;
  MockValue* arguments[3];
  size_t count = 2;
};

OwnedHandle* testOwner = nullptr;
MockCall* testCall = nullptr;
bool failMap = false;
bool failAllocation = false;
bool nullAllocation = false;
bool detachedTarget = false;
napi_status arrayBufferStatus = napi_ok;
napi_status detachedStatus = napi_ok;
napi_status arrayBufferInfoStatus = napi_ok;
napi_status undefinedStatus = napi_ok;
CopyMode copyMode = CopyMode::Normal;
const char* lastError = nullptr;
void* lastView = nullptr;
unsigned allocationCalls = 0;
unsigned copyCalls = 0;
unsigned mapCalls = 0;
unsigned isArrayBufferCalls = 0;
unsigned detachedCalls = 0;
unsigned arrayBufferInfoCalls = 0;
unsigned undefinedCalls = 0;
DWORD handlesAtAllocation = 0;
DWORD handlesAtCopy = 0;
std::vector<unsigned char> output(kBytes);
MockValue arrayBufferValue{ValueKind::ArrayBuffer, output.data(), kBytes};
MockValue undefinedValue{ValueKind::Undefined};

void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s (win32=%lu)\n", message, GetLastError());
    std::exit(1);
  }
}

DWORD handleCount() {
  DWORD count = 0;
  require(GetProcessHandleCount(GetCurrentProcess(), &count) != FALSE,
          "GetProcessHandleCount");
  return count;
}

bool viewIsMapped(void* address) {
  MEMORY_BASIC_INFORMATION memory{};
  return address && VirtualQuery(address, &memory, sizeof(memory)) == sizeof(memory) &&
    memory.State == MEM_COMMIT && memory.Type == MEM_MAPPED &&
    memory.AllocationBase == address;
}

void requireUnmappedAddress(const void* address) {
  require(address != nullptr, "failure reached a real mapped view");
  MEMORY_BASIC_INFORMATION memory{};
  require(VirtualQuery(address, &memory, sizeof(memory)) == sizeof(memory),
          "VirtualQuery released view");
  require(memory.State == MEM_FREE, "view was unmapped before callback returned");
}
void requireUnmapped() { requireUnmappedAddress(lastView); }

napi_value value(MockValue* mock) { return reinterpret_cast<napi_value>(mock); }
MockValue* mockValue(napi_value input) { return reinterpret_cast<MockValue*>(input); }

napi_status NAPI_CDECL mockGetCbInfo(napi_env, napi_callback_info info, size_t* argc,
                                   napi_value* argv, napi_value* self, void**) {
  auto* call = reinterpret_cast<MockCall*>(info);
  require(call == testCall, "callback uses controlled info");
  if (argc) {
    const size_t capacity = *argc;
    if (argv) for (size_t index = 0; index < capacity && index < call->count; ++index)
      argv[index] = value(call->arguments[index]);
    *argc = call->count;
  }
  if (self) *self = value(call->self);
  return napi_ok;
}
napi_status NAPI_CDECL mockCheckTag(napi_env, napi_value object,
                                  const napi_type_tag* tag, bool* tagged) {
  *tagged = mockValue(object)->kind == ValueKind::Owner &&
    tag->lower == kChildTag.lower && tag->upper == kChildTag.upper;
  return napi_ok;
}
napi_status NAPI_CDECL mockUnwrap(napi_env, napi_value object, void** result) {
  if (mockValue(object)->kind != ValueKind::Owner) return napi_invalid_arg;
  *result = static_cast<ChildOwner*>(testOwner);
  return napi_ok;
}
napi_status NAPI_CDECL mockTypeof(napi_env, napi_value input, napi_valuetype* result) {
  *result = mockValue(input)->kind == ValueKind::Number ? napi_number : napi_object;
  return napi_ok;
}
napi_status NAPI_CDECL mockGetDouble(napi_env, napi_value input, double* result) {
  if (mockValue(input)->kind != ValueKind::Number) return napi_number_expected;
  *result = mockValue(input)->number;
  return napi_ok;
}
napi_status NAPI_CDECL mockIsBuffer(napi_env, napi_value input, bool* result) {
  *result = mockValue(input)->kind == ValueKind::Buffer;
  return napi_ok;
}
napi_status NAPI_CDECL mockGetBuffer(napi_env, napi_value input, void** bytes, size_t* length) {
  if (mockValue(input)->kind != ValueKind::Buffer) return napi_invalid_arg;
  *bytes = mockValue(input)->bytes;
  *length = mockValue(input)->length;
  return napi_ok;
}
napi_status NAPI_CDECL mockIsArrayBuffer(napi_env, napi_value input, bool* result) {
  ++isArrayBufferCalls;
  if (arrayBufferStatus != napi_ok) return arrayBufferStatus;
  *result = mockValue(input)->kind == ValueKind::ArrayBuffer;
  return napi_ok;
}
napi_status NAPI_CDECL mockIsDetached(napi_env, napi_value, bool* result) {
  ++detachedCalls;
  if (detachedStatus != napi_ok) return detachedStatus;
  *result = detachedTarget;
  return napi_ok;
}
napi_status NAPI_CDECL mockGetArrayBuffer(napi_env, napi_value input,
                                       void** bytes, size_t* length) {
  ++arrayBufferInfoCalls;
  if (arrayBufferInfoStatus != napi_ok) return arrayBufferInfoStatus;
  if (mockValue(input)->kind != ValueKind::ArrayBuffer) return napi_arraybuffer_expected;
  *bytes = mockValue(input)->bytes;
  *length = mockValue(input)->length;
  return napi_ok;
}
napi_status NAPI_CDECL mockCreateArrayBuffer(napi_env, size_t bytes, void** storage,
                                           napi_value* result) {
  ++allocationCalls;
  require(viewIsMapped(lastView), "array allocation occurs with an owned mapped view");
  require(bytes == kBytes, "array allocation has the exact requested length");
  handlesAtAllocation = handleCount();
  if (failAllocation) return napi_generic_failure;
  *storage = nullAllocation ? nullptr : output.data();
  *result = value(&arrayBufferValue);
  return napi_ok;
}
napi_status NAPI_CDECL mockThrow(napi_env, const char*, const char* message) {
  lastError = message;
  return napi_ok;
}
napi_status NAPI_CDECL mockUndefined(napi_env, napi_value* result) {
  ++undefinedCalls;
  if (undefinedStatus != napi_ok) return undefinedStatus;
  *result = value(&undefinedValue);
  return napi_ok;
}

void resetCall() {
  lastError = nullptr;
  lastView = nullptr;
  allocationCalls = 0;
  copyCalls = 0;
  mapCalls = 0;
  isArrayBufferCalls = 0;
  detachedCalls = 0;
  arrayBufferInfoCalls = 0;
  undefinedCalls = 0;
  handlesAtAllocation = 0;
  handlesAtCopy = 0;
}

napi_value invoke() {
  return readFrame(reinterpret_cast<napi_env>(testCall),
                   reinterpret_cast<napi_callback_info>(testCall));
}

void expectFailure(const char* expectedError, DWORD baseline, bool mapped) {
  require(invoke() == nullptr, "failed readFrame returns nullptr");
  require(lastError && std::strcmp(lastError, expectedError) == 0,
          "failure throws the expected fixed error");
  require(handleCount() == baseline, "failure closes its duplicate mapping handle");
  if (mapped) requireUnmapped();
}

napi_value invokeCached(ChildOwner& child) {
  const double slot = testCall->arguments[0]->number;
  if (slot >= 0 && slot <= 2 && std::floor(slot) == slot)
    lastView = const_cast<void*>(child.frames[size_t(slot)].view);
  return readFrameCached(reinterpret_cast<napi_env>(testCall),
                         reinterpret_cast<napi_callback_info>(testCall));
}

napi_value invokePooled(ChildOwner& child) {
  const double slot = testCall->arguments[0]->number;
  if (slot >= 0 && slot <= 2 && std::floor(slot) == slot)
    lastView = const_cast<void*>(child.frames[size_t(slot)].view);
  return readFrameCachedInto(reinterpret_cast<napi_env>(testCall),
                             reinterpret_cast<napi_callback_info>(testCall));
}

void requireCacheEmpty(const ChildOwner& child) {
  for (const auto& frame : child.frames)
    require(!frame.section && !frame.view && !frame.source && !frame.bytes,
            "failed initial read does not publish a cached slot");
}

void expectCachedFailure(ChildOwner& child, const char* expectedError,
                         DWORD baseline, bool initialView) {
  require(invokeCached(child) == nullptr, "failed cached readFrame returns nullptr");
  require(lastError && std::strcmp(lastError, expectedError) == 0,
          "cached failure throws the expected fixed error");
  require(handleCount() == baseline, "cached failure releases its temporary handle");
  if (initialView) requireUnmapped();
}

void expectPooledFailure(ChildOwner& child, const char* expectedError,
                        DWORD baseline, bool initialView) {
  require(invokePooled(child) == nullptr, "failed pooled readFrame returns nullptr");
  require(lastError && std::strcmp(lastError, expectedError) == 0,
          "pooled failure throws the expected fixed error");
  require(handleCount() == baseline, "pooled failure retains no temporary handle");
  require(allocationCalls == 0, "pooled failure never allocates an ArrayBuffer");
  if (initialView) requireUnmapped();
}

void requireNoPooledMemoryWork() {
  require(allocationCalls == 0 && mapCalls == 0 && copyCalls == 0,
          "target validation failure occurs before allocation, map or copy");
}

void resolveObjectComparison() {
  for (const auto moduleName : {L"kernelbase.dll", L"kernel32.dll"}) {
    const HMODULE module = GetModuleHandleW(moduleName);
    const FARPROC symbol = module ? GetProcAddress(module, "CompareObjectHandles") : nullptr;
    if (symbol) {
      static_assert(sizeof(symbol) == sizeof(compareObjectHandles), "function pointer size");
      std::memcpy(&compareObjectHandles, &symbol, sizeof(symbol));
      break;
    }
  }
  require(compareObjectHandles != nullptr, "real CompareObjectHandles is available");
}

void initializeSyntheticSection(HANDLE mapping) {
  auto* writer = static_cast<unsigned char*>(::MapViewOfFile(
    mapping, FILE_MAP_WRITE, 0, 0, kBytes));
  require(writer != nullptr, "map extra synthetic source writer");
  for (size_t index = 0; index < kBytes; ++index)
    writer[index] = static_cast<unsigned char>((index * 37 + 19) & 255);
  require(UnmapViewOfFile(writer) != FALSE, "unmap extra synthetic source writer");
}
} // namespace

static LPVOID WINAPI testMapViewOfFile(HANDLE mapping, DWORD access, DWORD high,
                                      DWORD low, SIZE_T bytes) {
  ++mapCalls;
  require(access == FILE_MAP_READ, "production mapping is read only");
  require(high == 0 && low == 0 && bytes == kBytes, "production mapping is bounded");
  if (failMap) {
    SetLastError(ERROR_ACCESS_DENIED);
    return nullptr;
  }
  lastView = ::MapViewOfFile(mapping, access, high, low, bytes);
  return lastView;
}

static BOOL WINAPI testReadProcessMemory(HANDLE process, LPCVOID source, LPVOID target,
                                        SIZE_T bytes, SIZE_T* copied) {
  ++copyCalls;
  handlesAtCopy = handleCount();
  require(process == GetCurrentProcess(), "copy reads only this process");
  require(source == lastView && viewIsMapped(lastView), "copy reads the owned view");
  require(target == output.data() && bytes == kBytes, "copy writes only bounded array storage");
  if (copyMode != CopyMode::Normal) {
    const SIZE_T partial = bytes - 1;
    std::memcpy(target, source, partial);
    if (copied) *copied = partial;
    SetLastError(ERROR_PARTIAL_COPY);
    return copyMode == CopyMode::SuccessfulShort ? TRUE : FALSE;
  }
  return ::ReadProcessMemory(process, source, target, bytes, copied);
}

int main() {
  OwnedHandle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr,
                                       PAGE_READWRITE, 0, DWORD(kBytes), nullptr));
  require(mapping.get() != nullptr, "create synthetic unnamed pagefile mapping");
  auto* source = static_cast<unsigned char*>(::MapViewOfFile(
    mapping.get(), FILE_MAP_WRITE, 0, 0, kBytes));
  require(source != nullptr, "map synthetic source");
  for (size_t index = 0; index < kBytes; ++index)
    source[index] = static_cast<unsigned char>((index * 37 + 19) & 255);
  require(UnmapViewOfFile(source) != FALSE, "unmap synthetic source writer");

  ChildOwner process(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE |
                                  PROCESS_QUERY_LIMITED_INFORMATION,
                                  FALSE, GetCurrentProcessId()));
  require(process.get() != nullptr, "hold real controlled process object");
  testOwner = &process; // Isolate readFrame; openChild ownership is tested elsewhere.
  uint64_t sourceHandle = uint64_t(uintptr_t(mapping.get()));
  MockValue ownerValue{ValueKind::Owner};
  MockValue sourceValue{ValueKind::Buffer, &sourceHandle, sizeof(sourceHandle)};
  MockValue bytesValue{ValueKind::Number, nullptr, 0, double(kBytes)};
  MockCall call{&ownerValue, {&sourceValue, &bytesValue}};
  testCall = &call;

  api.napi_get_cb_info = mockGetCbInfo;
  api.napi_check_object_type_tag = mockCheckTag;
  api.napi_unwrap = mockUnwrap;
  api.napi_typeof = mockTypeof;
  api.napi_get_value_double = mockGetDouble;
  api.napi_is_buffer = mockIsBuffer;
  api.napi_get_buffer_info = mockGetBuffer;
  api.napi_is_arraybuffer = mockIsArrayBuffer;
  api.napi_is_detached_arraybuffer = mockIsDetached;
  api.napi_get_arraybuffer_info = mockGetArrayBuffer;
  api.napi_create_arraybuffer = mockCreateArrayBuffer;
  api.napi_throw_error = mockThrow;
  api.napi_throw_type_error = mockThrow;
  api.napi_get_undefined = mockUndefined;

  const DWORD baseline = handleCount();
  failMap = true;
  resetCall();
  expectFailure("source_frame_map_failed", baseline, false);
  require(allocationCalls == 0 && copyCalls == 0, "map failure does not allocate or copy");
  failMap = false;

  failAllocation = true;
  for (unsigned iteration = 0; iteration < 500; ++iteration) {
    resetCall();
    expectFailure("native_handle_api_failed", baseline, true);
    require(allocationCalls == 1 && copyCalls == 0,
            "allocation failure does not attempt a copy");
    require(handlesAtAllocation == baseline + 1,
            "only one temporary mapping handle exists during allocation");
  }
  failAllocation = false;

  nullAllocation = true;
  resetCall();
  expectFailure("native_frame_allocation_failed", baseline, true);
  require(allocationCalls == 1 && copyCalls == 0,
          "null allocation storage is rejected before a copy");
  nullAllocation = false;

  for (const auto mode : {CopyMode::FailedPartial, CopyMode::SuccessfulShort}) {
    copyMode = mode;
    for (unsigned iteration = 0; iteration < 500; ++iteration) {
      resetCall();
      expectFailure("source_frame_copy_failed", baseline, true);
      require(allocationCalls == 1 && copyCalls == 1, "partial copy is rejected exactly once");
    }
  }

  copyMode = CopyMode::Normal;
  resetCall();
  require(invoke() == value(&arrayBufferValue) && !lastError,
          "success returns the owned ArrayBuffer value");
  require(handleCount() == baseline, "success closes its duplicate mapping handle");
  requireUnmapped();
  for (size_t index = 0; index < kBytes; ++index)
    require(output[index] == static_cast<unsigned char>((index * 37 + 19) & 255),
            "success copies exact synthetic contents");

  resolveObjectComparison();
  OwnedHandle secondMapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr,
                                              PAGE_READWRITE, 0, DWORD(kBytes), nullptr));
  OwnedHandle thirdMapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr,
                                             PAGE_READWRITE, 0, DWORD(kBytes), nullptr));
  require(secondMapping.get() && thirdMapping.get(), "create three distinct source sections");
  require(!compareObjectHandles(mapping.get(), secondMapping.get()) &&
          !compareObjectHandles(mapping.get(), thirdMapping.get()) &&
          !compareObjectHandles(secondMapping.get(), thirdMapping.get()),
          "real kernel comparison distinguishes the source sections");
  initializeSyntheticSection(secondMapping.get());
  initializeSyntheticSection(thirdMapping.get());
  uint64_t otherHandles[2]{uint64_t(uintptr_t(secondMapping.get())),
                           uint64_t(uintptr_t(thirdMapping.get()))};
  MockValue otherSources[2]{{ValueKind::Buffer, &otherHandles[0], sizeof(uint64_t)},
                            {ValueKind::Buffer, &otherHandles[1], sizeof(uint64_t)}};
  MockValue* sources[3]{&sourceValue, &otherSources[0], &otherSources[1]};
  MockValue slotValue{ValueKind::Number, nullptr, 0, 0};
  MockCall cachedCall{&ownerValue, {&slotValue, sources[0], &bytesValue}, 3};
  MockValue pooledTarget{ValueKind::ArrayBuffer, output.data(), kBytes};
  MockCall pooledCall{&ownerValue, {&slotValue, sources[0], &pooledTarget}, 3};
  testCall = &cachedCall;
  const DWORD cacheBaseline = handleCount();

  failMap = true;
  resetCall();
  expectCachedFailure(process, "source_frame_map_failed", cacheBaseline, false);
  requireCacheEmpty(process);
  require(mapCalls == 1 && allocationCalls == 0 && copyCalls == 0,
          "first cached map failure does not allocate or copy");
  failMap = false;

  failAllocation = true;
  for (unsigned iteration = 0; iteration < 100; ++iteration) {
    resetCall();
    expectCachedFailure(process, "native_handle_api_failed", cacheBaseline, true);
    requireCacheEmpty(process);
    require(mapCalls == 1 && allocationCalls == 1 && copyCalls == 0,
            "first cached allocation failure retains no mapped slot");
  }
  failAllocation = false;
  for (const auto mode : {CopyMode::FailedPartial, CopyMode::SuccessfulShort}) {
    copyMode = mode;
    for (unsigned iteration = 0; iteration < 100; ++iteration) {
      resetCall();
      expectCachedFailure(process, "source_frame_copy_failed", cacheBaseline, true);
      requireCacheEmpty(process);
      require(mapCalls == 1 && allocationCalls == 1 && copyCalls == 1,
              "first cached partial copy retains no mapped slot");
    }
  }
  copyMode = CopyMode::Normal;

  testCall = &pooledCall;
  require(supportsCachedCpuFramesInto(), "optional APIs enable the pooled capability");
  auto expectInitialTargetFailure = [&](const char* expectedError) {
    resetCall();
    expectPooledFailure(process, expectedError, cacheBaseline, false);
    requireNoPooledMemoryWork();
    requireCacheEmpty(process);
  };
  const auto savedGetArrayBuffer = api.napi_get_arraybuffer_info;
  api.napi_get_arraybuffer_info = nullptr;
  require(!supportsCachedCpuFramesInto(), "missing optional API disables pooled capability");
  expectInitialTargetFailure("cpu_frame_pool_unsupported");
  api.napi_get_arraybuffer_info = savedGetArrayBuffer;

  pooledCall.arguments[2] = &bytesValue;
  expectInitialTargetFailure("invalid_frame_target");
  require(isArrayBufferCalls == 1 && detachedCalls == 0 && arrayBufferInfoCalls == 0,
          "non ArrayBuffer target is rejected before storage queries");
  pooledCall.arguments[2] = &pooledTarget;
  detachedTarget = true;
  expectInitialTargetFailure("invalid_frame_target");
  require(isArrayBufferCalls == 1 && detachedCalls == 1 && arrayBufferInfoCalls == 0,
          "detached target is rejected before obtaining a data pointer");
  detachedTarget = false;
  arrayBufferStatus = napi_generic_failure;
  expectInitialTargetFailure("native_handle_api_failed");
  require(detachedCalls == 0 && arrayBufferInfoCalls == 0,
          "is ArrayBuffer status failure stops all later target work");
  arrayBufferStatus = napi_ok;
  detachedStatus = napi_generic_failure;
  expectInitialTargetFailure("native_handle_api_failed");
  require(arrayBufferInfoCalls == 0 && undefinedCalls == 0,
          "detached status failure stops all later target work");
  detachedStatus = napi_ok;
  arrayBufferInfoStatus = napi_generic_failure;
  expectInitialTargetFailure("native_handle_api_failed");
  require(arrayBufferInfoCalls == 1 && undefinedCalls == 0,
          "array info failure occurs before even preparing the return value");
  arrayBufferInfoStatus = napi_ok;
  undefinedStatus = napi_generic_failure;
  expectInitialTargetFailure("native_handle_api_failed");
  require(arrayBufferInfoCalls == 1 && undefinedCalls == 1,
          "undefined status failure stops before map and copy");
  undefinedStatus = napi_ok;
  pooledTarget.bytes = nullptr;
  expectInitialTargetFailure("invalid_frame_target");
  pooledTarget.bytes = output.data();
  pooledTarget.length = 0;
  expectInitialTargetFailure("invalid_frame_target");
  pooledTarget.length = 16 * 1024 * 1024 + 1;
  expectInitialTargetFailure("invalid_frame_target");
  pooledTarget.length = kBytes;

  failMap = true;
  resetCall();
  expectPooledFailure(process, "source_frame_map_failed", cacheBaseline, false);
  requireCacheEmpty(process);
  require(mapCalls == 1 && copyCalls == 0, "first pooled map failure never copies");
  failMap = false;
  for (const auto mode : {CopyMode::FailedPartial, CopyMode::SuccessfulShort}) {
    copyMode = mode;
    for (unsigned iteration = 0; iteration < 100; ++iteration) {
      resetCall();
      expectPooledFailure(process, "source_frame_copy_failed", cacheBaseline, true);
      requireCacheEmpty(process);
      require(mapCalls == 1 && copyCalls == 1 && handlesAtCopy == cacheBaseline + 1,
              "first pooled partial copy never publishes or retains its section");
    }
  }
  copyMode = CopyMode::Normal;
  resetCall();
  require(invokePooled(process) == value(&undefinedValue) && !lastError,
          "first pooled success returns undefined");
  require(allocationCalls == 0 && mapCalls == 1 && copyCalls == 1,
          "first pooled success uses the supplied storage without allocation");
  require(handleCount() == cacheBaseline + 1 && process.frames[0].section &&
          viewIsMapped(const_cast<void*>(process.frames[0].view)),
          "first pooled success publishes exactly one owned section and view");
  const void* initialPooledView = process.frames[0].view;
  require(process.frames[0].close(), "release isolated pooled first-success slot");
  require(handleCount() == cacheBaseline, "isolated pooled slot release restores handles");
  requireUnmappedAddress(initialPooledView);
  requireCacheEmpty(process);
  testCall = &cachedCall;

  const void* cachedViews[3]{};
  HANDLE cachedSections[3]{};
  for (size_t slot = 0; slot < 3; ++slot) {
    slotValue.number = double(slot);
    cachedCall.arguments[1] = sources[slot];
    resetCall();
    require(invokeCached(process) == value(&arrayBufferValue) && !lastError,
            "initial cached slot read succeeds");
    require(mapCalls == 1 && allocationCalls == 1 && copyCalls == 1,
            "initial cached slot maps exactly once");
    require(handleCount() == cacheBaseline + DWORD(slot) + 1,
            "each slot owns exactly one section handle");
    const auto& cached = process.frames[slot];
    require(cached.section && cached.view && cached.source && cached.bytes == kBytes,
            "successful slot publishes a complete cache entry");
    require(compareObjectHandles(cached.section,
            reinterpret_cast<HANDLE>(uintptr_t(*static_cast<uint64_t*>(sources[slot]->bytes)))) != FALSE,
            "cached handle belongs to the exact source section object");
    cachedViews[slot] = cached.view;
    cachedSections[slot] = cached.section;
  }
  const DWORD fullCacheHandles = cacheBaseline + 3;
  auto requireCacheRetained = [&]() {
    require(handleCount() == fullCacheHandles, "cache remains bounded to three section handles");
    for (size_t slot = 0; slot < 3; ++slot) {
      require(process.frames[slot].section == cachedSections[slot] &&
              process.frames[slot].view == cachedViews[slot] &&
              viewIsMapped(const_cast<void*>(cachedViews[slot])),
              "cached handles and views remain unchanged");
    }
  };

  for (unsigned iteration = 0; iteration < 600; ++iteration) {
    const size_t slot = iteration % 3;
    slotValue.number = double(slot);
    cachedCall.arguments[1] = sources[slot];
    resetCall();
    require(invokeCached(process) == value(&arrayBufferValue) && !lastError,
            "cached slot hit succeeds");
    require(mapCalls == 0 && allocationCalls == 1 && copyCalls == 1,
            "cached hit never creates another view");
    require(handlesAtAllocation == fullCacheHandles + 1,
            "cached hit has exactly one temporary identity-check duplicate");
    requireCacheRetained();
  }

  failAllocation = true;
  for (unsigned iteration = 0; iteration < 300; ++iteration) {
    const size_t slot = iteration % 3;
    slotValue.number = double(slot);
    cachedCall.arguments[1] = sources[slot];
    resetCall();
    expectCachedFailure(process, "native_handle_api_failed", fullCacheHandles, false);
    require(mapCalls == 0 && allocationCalls == 1 && copyCalls == 0,
            "cached allocation failure does not remap or copy");
    requireCacheRetained();
  }
  failAllocation = false;
  nullAllocation = true;
  resetCall();
  expectCachedFailure(process, "native_frame_allocation_failed", fullCacheHandles, false);
  require(mapCalls == 0 && copyCalls == 0, "cached null allocation does not map or copy");
  requireCacheRetained();
  nullAllocation = false;

  for (const auto mode : {CopyMode::FailedPartial, CopyMode::SuccessfulShort}) {
    copyMode = mode;
    for (unsigned iteration = 0; iteration < 300; ++iteration) {
      const size_t slot = iteration % 3;
      slotValue.number = double(slot);
      cachedCall.arguments[1] = sources[slot];
      resetCall();
      expectCachedFailure(process, "source_frame_copy_failed", fullCacheHandles, false);
      require(mapCalls == 0 && allocationCalls == 1 && copyCalls == 1,
              "cached partial copy does not remap");
      requireCacheRetained();
    }
  }
  copyMode = CopyMode::Normal;

  testCall = &pooledCall;
  for (unsigned iteration = 0; iteration < 600; ++iteration) {
    const size_t slot = iteration % 3;
    slotValue.number = double(slot);
    pooledCall.arguments[1] = sources[slot];
    resetCall();
    require(invokePooled(process) == value(&undefinedValue) && !lastError,
            "pooled cached hit returns undefined");
    require(allocationCalls == 0 && mapCalls == 0 && copyCalls == 1,
            "pooled cached hit neither allocates an ArrayBuffer nor remaps");
    require(handlesAtCopy == fullCacheHandles + 1,
            "pooled hit owns only one temporary identity-check duplicate");
    require(isArrayBufferCalls == 1 && detachedCalls == 1 &&
            arrayBufferInfoCalls == 1 && undefinedCalls == 1,
            "pooled hit validates the current supplied storage exactly once");
    requireCacheRetained();
  }
  for (const auto mode : {CopyMode::FailedPartial, CopyMode::SuccessfulShort}) {
    copyMode = mode;
    for (unsigned iteration = 0; iteration < 300; ++iteration) {
      const size_t slot = iteration % 3;
      slotValue.number = double(slot);
      pooledCall.arguments[1] = sources[slot];
      resetCall();
      expectPooledFailure(process, "source_frame_copy_failed", fullCacheHandles, false);
      require(mapCalls == 0 && copyCalls == 1 && handlesAtCopy == fullCacheHandles + 1,
              "pooled cached partial copy retains only the existing three slots");
      requireCacheRetained();
    }
  }
  copyMode = CopyMode::Normal;

  auto expectCachedTargetFailure = [&](const char* expectedError) {
    resetCall();
    expectPooledFailure(process, expectedError, fullCacheHandles, false);
    requireNoPooledMemoryWork();
    requireCacheRetained();
  };
  arrayBufferInfoStatus = napi_generic_failure;
  expectCachedTargetFailure("native_handle_api_failed");
  arrayBufferInfoStatus = napi_ok;
  undefinedStatus = napi_generic_failure;
  expectCachedTargetFailure("native_handle_api_failed");
  undefinedStatus = napi_ok;
  detachedTarget = true;
  expectCachedTargetFailure("invalid_frame_target");
  detachedTarget = false;
  pooledCall.arguments[2] = &sourceValue;
  expectCachedTargetFailure("invalid_frame_target");
  pooledCall.arguments[2] = &pooledTarget;
  testCall = &cachedCall;

  resetCall();
  require(closeChild(reinterpret_cast<napi_env>(&cachedCall),
                     reinterpret_cast<napi_callback_info>(&cachedCall)) == value(&undefinedValue) &&
          !lastError, "public child close succeeds with all three cached slots");
  require(handleCount() == cacheBaseline - 1, "child close releases three sections and process handle");
  requireCacheEmpty(process);
  for (const auto view : cachedViews) requireUnmappedAddress(view);
  require(closeChild(reinterpret_cast<napi_env>(&cachedCall),
                     reinterpret_cast<napi_callback_info>(&cachedCall)) == value(&undefinedValue),
          "repeated public child close is idempotent");
  require(handleCount() == cacheBaseline - 1, "repeated close does not close reused handles");

  testCall = &call;
  resetCall();
  expectFailure("child_unavailable", cacheBaseline - 1, false);
  require(allocationCalls == 0 && copyCalls == 0, "closed owner never maps or copies");
  testCall = &cachedCall;
  resetCall();
  expectCachedFailure(process, "child_unavailable", cacheBaseline - 1, false);
  require(mapCalls == 0 && allocationCalls == 0 && copyCalls == 0,
          "closed cached owner never maps, allocates or copies");
  testCall = &pooledCall;
  resetCall();
  expectPooledFailure(process, "child_unavailable", cacheBaseline - 1, false);
  requireNoPooledMemoryWork();
  require(isArrayBufferCalls == 0 && detachedCalls == 0 && arrayBufferInfoCalls == 0,
          "closed pooled owner is rejected before querying target storage");

  const DWORD finalizedBaseline = handleCount();
  auto* finalizedOwner = new ChildOwner(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE |
                                                   PROCESS_QUERY_LIMITED_INFORMATION,
                                                   FALSE, GetCurrentProcessId()));
  require(finalizedOwner->get() != nullptr, "hold separate process owner for finalizer test");
  testOwner = finalizedOwner;
  testCall = &cachedCall;
  const void* finalizedViews[3]{};
  for (size_t slot = 0; slot < 3; ++slot) {
    slotValue.number = double(slot);
    cachedCall.arguments[1] = sources[slot];
    resetCall();
    require(invokeCached(*finalizedOwner) == value(&arrayBufferValue) && !lastError,
            "populate cache owned solely by finalizer");
    finalizedViews[slot] = finalizedOwner->frames[slot].view;
  }
  require(handleCount() == finalizedBaseline + 4,
          "finalizer owner holds one process and three section handles");
  testCall = &pooledCall;
  for (size_t slot = 0; slot < 3; ++slot) {
    slotValue.number = double(slot);
    pooledCall.arguments[1] = sources[slot];
    resetCall();
    require(invokePooled(*finalizedOwner) == value(&undefinedValue) && !lastError,
            "pooled method can reuse every finalizer-owned slot");
    require(allocationCalls == 0 && mapCalls == 0 && copyCalls == 1,
            "pooled finalizer-owned slot reuse creates no storage or mapping");
    require(handleCount() == finalizedBaseline + 4,
            "pooled finalizer-owned reuse closes its temporary duplicate");
  }
  finalizeChild(nullptr, finalizedOwner, nullptr);
  testOwner = nullptr;
  require(handleCount() == finalizedBaseline, "child finalizer releases all owned handles");
  for (const auto view : finalizedViews) requireUnmappedAddress(view);

  std::puts("PASS: legacy, cached and pooled failures; bounded three-slot caches; pooled hits never allocate or remap; target validation precedes memory work; close and finalizer release every handle and view");
  return 0;
}
