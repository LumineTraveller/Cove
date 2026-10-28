// Main-process-only ownership bridge. N-API 8, no Electron/Node import library.
// Every main-table handle has exactly one native owner from DuplicateHandle
// through close/finalizer. The capture helper never writes the main handle table.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define NAPI_VERSION 8
#define NAPI_EXTERN
#include <windows.h>
#include <tlhelp32.h>
#include <node_api.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <new>

#define API_FUNCTIONS(X) \
  X(napi_get_cb_info) X(napi_typeof) X(napi_get_value_double) \
  X(napi_is_buffer) X(napi_get_buffer_info) X(napi_create_object) \
  X(napi_create_buffer_copy) X(napi_create_arraybuffer) X(napi_create_double) X(napi_get_boolean) \
  X(napi_define_properties) X(napi_wrap) X(napi_unwrap) \
  X(napi_get_undefined) X(napi_throw_error) X(napi_throw_type_error) \
  X(napi_type_tag_object) X(napi_check_object_type_tag)
#define OPTIONAL_API_FUNCTIONS(X) \
  X(napi_is_arraybuffer) X(napi_is_detached_arraybuffer) X(napi_get_arraybuffer_info)
struct Api {
#define FIELD(name) decltype(&::name) name = nullptr;
  API_FUNCTIONS(FIELD)
  OPTIONAL_API_FUNCTIONS(FIELD)
#undef FIELD
  bool ready = false;
};
static Api api;
static INIT_ONCE apiOnce = INIT_ONCE_STATIC_INIT;
using CompareObjectHandlesFn = BOOL (WINAPI*)(HANDLE, HANDLE);
static CompareObjectHandlesFn compareObjectHandles = nullptr;
static BOOL CALLBACK loadApi(PINIT_ONCE, PVOID, PVOID*) {
  const HMODULE host = GetModuleHandleW(nullptr);
  bool ready = host != nullptr;
#define LOAD(name) { \
  const FARPROC symbol = host ? GetProcAddress(host, #name) : nullptr; \
  static_assert(sizeof(symbol) == sizeof(api.name), "N-API function pointer size"); \
  std::memcpy(&api.name, &symbol, sizeof(symbol)); \
  ready = ready && api.name != nullptr; \
  }
  API_FUNCTIONS(LOAD)
#undef LOAD
#define LOAD_OPTIONAL(name) { \
  const FARPROC symbol = host ? GetProcAddress(host, #name) : nullptr; \
  static_assert(sizeof(symbol) == sizeof(api.name), "N-API function pointer size"); \
  std::memcpy(&api.name, &symbol, sizeof(symbol)); \
  }
  OPTIONAL_API_FUNCTIONS(LOAD_OPTIONAL)
#undef LOAD_OPTIONAL
  // Optional cache capability: only inspect already loaded Windows modules.
  // No guessed handle identity or fallback to numeric equality is permitted.
  for (const auto moduleName : {L"kernelbase.dll", L"kernel32.dll"}) {
    const HMODULE module = GetModuleHandleW(moduleName);
    const FARPROC symbol = module ? GetProcAddress(module, "CompareObjectHandles") : nullptr;
    if (symbol) {
      static_assert(sizeof(symbol) == sizeof(compareObjectHandles), "Win32 function pointer size");
      std::memcpy(&compareObjectHandles, &symbol, sizeof(symbol));
      break;
    }
  }
  api.ready = ready;
  return TRUE;
}

class OwnedHandle {
  HANDLE value_ = nullptr;
public:
  OwnedHandle() = default;
  explicit OwnedHandle(HANDLE value) : value_(value) {}
  OwnedHandle(const OwnedHandle&) = delete;
  OwnedHandle& operator=(const OwnedHandle&) = delete;
  ~OwnedHandle() { close(); }
  HANDLE get() const { return value_; }
  HANDLE take() { const HANDLE value = value_; value_ = nullptr; return value; }
  bool close() noexcept {
    const HANDLE value = take(); // Clear before closing; never retry recycled values.
    return !value || value == INVALID_HANDLE_VALUE || CloseHandle(value) != FALSE;
  }
};
class OwnedView {
  const void* value_ = nullptr;
public:
  explicit OwnedView(const void* value) : value_(value) {}
  OwnedView(const OwnedView&) = delete;
  OwnedView& operator=(const OwnedView&) = delete;
  ~OwnedView() { if (value_) UnmapViewOfFile(value_); }
  const void* get() const { return value_; }
  const void* take() { const void* value = value_; value_ = nullptr; return value; }
};
struct CachedFrame {
  HANDLE source = nullptr;
  HANDLE section = nullptr;
  const void* view = nullptr;
  size_t bytes = 0;
  CachedFrame() = default;
  CachedFrame(const CachedFrame&) = delete;
  CachedFrame& operator=(const CachedFrame&) = delete;
  ~CachedFrame() { close(); }
  bool close() noexcept {
    const void* oldView = view; view = nullptr;
    const HANDLE oldSection = section; section = nullptr;
    source = nullptr; bytes = 0;
    const bool unmapped = !oldView || UnmapViewOfFile(oldView) != FALSE;
    const bool closed = !oldSection || CloseHandle(oldSection) != FALSE;
    return unmapped && closed;
  }
};
class ChildOwner : public OwnedHandle {
public:
  CachedFrame frames[3];
  explicit ChildOwner(HANDLE process) : OwnedHandle(process) {}
  ~ChildOwner() { close(); }
  bool close() noexcept {
    bool success = true;
    for (auto& frame : frames) if (!frame.close()) success = false;
    if (!OwnedHandle::close()) success = false;
    return success;
  }
};
static const napi_type_tag kResourceTag{0x7b7ea44a65064ae1ULL, 0x92f07d8c51740833ULL};
static const napi_type_tag kChildTag{0x49363492245e4b23ULL, 0xb5e67b39f30c4430ULL};
static napi_value fail(napi_env env, const char* code, bool type = false) {
  if (type) api.napi_throw_type_error(env, nullptr, code);
  else api.napi_throw_error(env, nullptr, code);
  return nullptr;
}
static bool ok(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  fail(env, "native_handle_api_failed"); return false;
}
static void NAPI_CDECL finalize(napi_env, void* data, void*) {
  delete static_cast<OwnedHandle*>(data);
}
static void NAPI_CDECL finalizeChild(napi_env, void* data, void*) {
  delete static_cast<ChildOwner*>(data);
}
static OwnedHandle* unwrap(napi_env env, napi_value object, const napi_type_tag& tag) {
  bool tagged = false;
  if (!ok(env, api.napi_check_object_type_tag(env, object, &tag, &tagged))) return nullptr;
  if (!tagged) { fail(env, "invalid_native_handle_owner", true); return nullptr; }
  void* data = nullptr;
  if (!ok(env, api.napi_unwrap(env, object, &data))) return nullptr;
  if (!data) { fail(env, "invalid_native_handle_owner", true); return nullptr; }
  // napi_wrap stores the complete ChildOwner pointer; perform the derived to
  // base conversion before returning it rather than assuming base offset zero.
  if (tag.lower == kChildTag.lower && tag.upper == kChildTag.upper)
    return static_cast<ChildOwner*>(data);
  return static_cast<OwnedHandle*>(data);
}
static napi_value closeOwner(napi_env env, napi_callback_info info, const napi_type_tag& tag) {
  napi_value self = nullptr; size_t count = 0;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, nullptr, &self, nullptr))) return nullptr;
  auto* owned = unwrap(env, self, tag);
  if (!owned) return nullptr;
  if (!owned->close()) return fail(env, "native_handle_close_failed");
  napi_value result = nullptr;
  if (!ok(env, api.napi_get_undefined(env, &result))) return nullptr;
  return result;
}
static napi_value NAPI_CDECL closeResource(napi_env env, napi_callback_info info) {
  return closeOwner(env, info, kResourceTag);
}
static napi_value NAPI_CDECL closeChild(napi_env env, napi_callback_info info) {
  napi_value self = nullptr; size_t count = 0;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, nullptr, &self, nullptr))) return nullptr;
  auto* child = static_cast<ChildOwner*>(unwrap(env, self, kChildTag));
  if (!child) return nullptr;
  if (!child->close()) return fail(env, "native_handle_close_failed");
  napi_value result = nullptr;
  if (!ok(env, api.napi_get_undefined(env, &result))) return nullptr;
  return result;
}
// Snapshot-only process CPU accounting. Never called by the frame duplicate
// path; the same held process object also permits a final reading after exit.
static napi_value NAPI_CDECL cpuSeconds(napi_env env, napi_callback_info info) {
  napi_value self = nullptr; size_t count = 0;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, nullptr, &self, nullptr))) return nullptr;
  auto* child = unwrap(env, self, kChildTag);
  if (!child) return nullptr;
  if (!child->get()) return fail(env, "child_unavailable");
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(child->get(), &created, &exited, &kernel, &user))
    return fail(env, "child_cpu_times_unavailable");
  const uint64_t kernelTicks = (uint64_t(kernel.dwHighDateTime) << 32) | kernel.dwLowDateTime;
  const uint64_t userTicks = (uint64_t(user.dwHighDateTime) << 32) | user.dwLowDateTime;
  const double seconds = double(kernelTicks) / 10000000.0 + double(userTicks) / 10000000.0;
  napi_value result = nullptr;
  if (!ok(env, api.napi_create_double(env, seconds, &result))) return nullptr;
  return result;
}
static bool childOfThisProcess(DWORD pid) {
  OwnedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.get() || snapshot.get() == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.get(), &entry)) do {
    if (entry.th32ProcessID == pid) return entry.th32ParentProcessID == GetCurrentProcessId();
  } while (Process32NextW(snapshot.get(), &entry));
  return false;
}
static HANDLE openOwnedChild(napi_env env, napi_value argument) {
  napi_valuetype type = napi_undefined;
  if (!ok(env, api.napi_typeof(env, argument, &type))) return nullptr;
  if (type != napi_number) { fail(env, "invalid_child_pid", true); return nullptr; }
  double number = 0;
  if (!ok(env, api.napi_get_value_double(env, argument, &number))) return nullptr;
  if (!std::isfinite(number) || number <= 0 || number > MAXDWORD || std::floor(number) != number ||
      DWORD(number) == GetCurrentProcessId()) { fail(env, "invalid_child_pid", true); return nullptr; }
  const DWORD pid = DWORD(number);
  // Keep the real process object open for this entire session. No global PID
  // cache, per-frame Toolhelp snapshot or PID reopen after the child exits.
  OwnedHandle process(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.get() || WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) {
    fail(env, "child_unavailable"); return nullptr;
  }
  if (!childOfThisProcess(pid)) { fail(env, "child_not_owned"); return nullptr; }
  if (WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) { fail(env, "child_unavailable"); return nullptr; }
  return process.take();
}
static bool sourceValue(napi_env env, napi_value argument, HANDLE* result) {
  bool buffer = false;
  if (!ok(env, api.napi_is_buffer(env, argument, &buffer))) return false;
  if (!buffer) { fail(env, "source_handle_must_be_buffer8", true); return false; }
  void* bytes = nullptr; size_t length = 0;
  if (!ok(env, api.napi_get_buffer_info(env, argument, &bytes, &length))) return false;
  if (!bytes || length != sizeof(uint64_t)) { fail(env, "source_handle_must_be_buffer8", true); return false; }
  uint64_t value = 0; std::memcpy(&value, bytes, sizeof(value));
  // Reject null and negative/pseudo handles. NT resource handles are positive.
  if (!value || value > uint64_t(INT64_MAX)) { fail(env, "invalid_source_handle", true); return false; }
  *result = reinterpret_cast<HANDLE>(uintptr_t(value));
  return true;
}
static napi_value wrapResource(napi_env env, OwnedHandle& local) {
  napi_value object = nullptr, buffer = nullptr;
  if (!ok(env, api.napi_create_object(env, &object))) return nullptr;
  const uint64_t value = uint64_t(uintptr_t(local.get()));
  if (!ok(env, api.napi_create_buffer_copy(env, sizeof(value), &value, nullptr, &buffer))) return nullptr;
  if (!ok(env, api.napi_type_tag_object(env, object, &kResourceTag))) return nullptr;
  const napi_property_descriptor properties[]{
    {"handle", nullptr, nullptr, nullptr, nullptr, buffer, napi_enumerable, nullptr},
    {"close", nullptr, closeResource, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (!ok(env, api.napi_define_properties(env, object, 2, properties))) return nullptr;
  auto* owned = new (std::nothrow) OwnedHandle(local.get());
  if (!owned) return fail(env, "native_handle_allocation_failed");
  local.take();
  if (!ok(env, api.napi_wrap(env, object, owned, finalize, nullptr, nullptr))) { delete owned; return nullptr; }
  return object;
}
static napi_value duplicateResource(napi_env env, OwnedHandle& child, napi_value argument) {
  HANDLE source = nullptr;
  if (!sourceValue(env, argument, &source)) return nullptr;
  if (!child.get() || WaitForSingleObject(child.get(), 0) != WAIT_TIMEOUT) return fail(env, "child_unavailable");
  HANDLE result = nullptr;
  if (!DuplicateHandle(child.get(), source, GetCurrentProcess(), &result, 0, FALSE, DUPLICATE_SAME_ACCESS))
    return fail(env, "source_handle_duplicate_failed");
  OwnedHandle local(result);
  return wrapResource(env, local);
}
static napi_value NAPI_CDECL duplicate(napi_env env, napi_callback_info info) {
  napi_value arguments[2]{}, self = nullptr; size_t count = 2;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, arguments, &self, nullptr))) return nullptr;
  if (count != 1) return fail(env, "expected_source_handle", true);
  auto* child = unwrap(env, self, kChildTag);
  if (!child) return nullptr;
  return duplicateResource(env, *child, arguments[0]);
}
// CPU frames are copied into a normal JS-owned ArrayBuffer. The helper retains
// the source slot until this synchronous call returns and its caller acks it.
// No native mapping or writable external memory crosses the N-API boundary.
static napi_value NAPI_CDECL readFrame(napi_env env, napi_callback_info info) {
  napi_value arguments[3]{}, self = nullptr; size_t count = 3;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, arguments, &self, nullptr))) return nullptr;
  if (count != 2) return fail(env, "expected_source_handle_and_byte_length", true);
  auto* child = unwrap(env, self, kChildTag);
  if (!child) return nullptr;
  if (!child->get() || WaitForSingleObject(child->get(), 0) != WAIT_TIMEOUT)
    return fail(env, "child_unavailable");
  HANDLE source = nullptr;
  if (!sourceValue(env, arguments[0], &source)) return nullptr;
  napi_valuetype type = napi_undefined;
  if (!ok(env, api.napi_typeof(env, arguments[1], &type))) return nullptr;
  if (type != napi_number) return fail(env, "invalid_frame_byte_length", true);
  double number = 0;
  if (!ok(env, api.napi_get_value_double(env, arguments[1], &number))) return nullptr;
  // This cap is below MAX_SAFE_INTEGER and SIZE_MAX on the supported x64 host.
  if (!std::isfinite(number) || number <= 0 || number > 16 * 1024 * 1024 || std::floor(number) != number)
    return fail(env, "invalid_frame_byte_length", true);
  const size_t bytes = size_t(number);
  HANDLE duplicated = nullptr;
  if (!DuplicateHandle(child->get(), source, GetCurrentProcess(), &duplicated, FILE_MAP_READ, FALSE, 0))
    return fail(env, "source_handle_duplicate_failed");
  OwnedHandle local(duplicated);
  OwnedView view(MapViewOfFile(local.get(), FILE_MAP_READ, 0, 0, bytes));
  if (!view.get()) return fail(env, "source_frame_map_failed");
  napi_value result = nullptr; void* destination = nullptr;
  if (!ok(env, api.napi_create_arraybuffer(env, bytes, &destination, &result))) return nullptr;
  if (!destination) return fail(env, "native_frame_allocation_failed");
  SIZE_T copied = 0;
  // The kernel validates the entire range and reports in-page/partial errors;
  // an invalid child mapping must never raise an access fault across Node.
  if (!ReadProcessMemory(GetCurrentProcess(), view.get(), destination, bytes, &copied) || copied != bytes)
    return fail(env, "source_frame_copy_failed");
  return result;
}
static bool supportsCachedCpuFramesInto() {
  return compareObjectHandles && api.napi_is_arraybuffer && api.napi_is_detached_arraybuffer &&
    api.napi_get_arraybuffer_info;
}
static napi_value readFrameCachedCore(napi_env env, napi_callback_info info, bool into) {
  napi_value arguments[4]{}, self = nullptr; size_t count = 4;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, arguments, &self, nullptr))) return nullptr;
  if (count != 3) return fail(env, into ? "expected_slot_source_handle_and_target" :
    "expected_slot_source_handle_and_byte_length", true);
  auto* child = static_cast<ChildOwner*>(unwrap(env, self, kChildTag));
  if (!child) return nullptr;
  if (!child->get() || WaitForSingleObject(child->get(), 0) != WAIT_TIMEOUT)
    return fail(env, "child_unavailable");
  if (!compareObjectHandles) return fail(env, "cpu_frame_cache_unsupported");
  if (into && !supportsCachedCpuFramesInto()) return fail(env, "cpu_frame_pool_unsupported");
  napi_valuetype type = napi_undefined;
  if (!ok(env, api.napi_typeof(env, arguments[0], &type))) return nullptr;
  if (type != napi_number) return fail(env, "invalid_frame_slot", true);
  double slotNumber = 0;
  if (!ok(env, api.napi_get_value_double(env, arguments[0], &slotNumber))) return nullptr;
  if (!std::isfinite(slotNumber) || slotNumber < 0 || slotNumber > 2 || std::floor(slotNumber) != slotNumber)
    return fail(env, "invalid_frame_slot", true);
  HANDLE source = nullptr;
  if (!sourceValue(env, arguments[1], &source)) return nullptr;
  size_t bytes = 0; void* destination = nullptr; napi_value result = nullptr;
  if (into) {
    bool arrayBuffer = false, detached = false;
    if (!ok(env, api.napi_is_arraybuffer(env, arguments[2], &arrayBuffer))) return nullptr;
    if (!arrayBuffer) return fail(env, "invalid_frame_target", true);
    if (!ok(env, api.napi_is_detached_arraybuffer(env, arguments[2], &detached))) return nullptr;
    if (detached) return fail(env, "invalid_frame_target", true);
    if (!ok(env, api.napi_get_arraybuffer_info(env, arguments[2], &destination, &bytes))) return nullptr;
    if (!destination || !bytes || bytes > 16 * 1024 * 1024)
      return fail(env, "invalid_frame_target", true);
    // The callback argument roots this ordinary, nonshared ArrayBuffer until
    // return. No JS callback or native/external storage is retained by a slot.
    if (!ok(env, api.napi_get_undefined(env, &result))) return nullptr;
  } else {
    if (!ok(env, api.napi_typeof(env, arguments[2], &type))) return nullptr;
    if (type != napi_number) return fail(env, "invalid_frame_byte_length", true);
    double number = 0;
    if (!ok(env, api.napi_get_value_double(env, arguments[2], &number))) return nullptr;
    if (!std::isfinite(number) || number <= 0 || number > 16 * 1024 * 1024 || std::floor(number) != number)
      return fail(env, "invalid_frame_byte_length", true);
    bytes = size_t(number);
  }
  auto& cached = child->frames[size_t(slotNumber)];
  if (cached.section && (cached.source != source || cached.bytes != bytes))
    return fail(env, "cached_frame_mismatch");
  HANDLE duplicated = nullptr;
  if (!DuplicateHandle(child->get(), source, GetCurrentProcess(), &duplicated, FILE_MAP_READ, FALSE, 0))
    return fail(env, "source_handle_duplicate_failed");
  OwnedHandle local(duplicated);
  // The fresh duplicate closes the handle-reuse race: numeric handle equality
  // alone must never select a cached mapping to a different section object.
  if (cached.section && !compareObjectHandles(cached.section, local.get()))
    return fail(env, "cached_frame_mismatch");
  OwnedView initialView(cached.section ? nullptr : MapViewOfFile(local.get(), FILE_MAP_READ, 0, 0, bytes));
  const void* view = cached.section ? cached.view : initialView.get();
  if (!view) return fail(env, "source_frame_map_failed");
  if (!into) {
    if (!ok(env, api.napi_create_arraybuffer(env, bytes, &destination, &result))) return nullptr;
    if (!destination) return fail(env, "native_frame_allocation_failed");
  }
  SIZE_T copied = 0;
  if (!ReadProcessMemory(GetCurrentProcess(), view, destination, bytes, &copied) || copied != bytes)
    return fail(env, "source_frame_copy_failed");
  if (!cached.section) {
    // Publish only a fully validated, successfully copied slot. Initial map,
    // allocation or copy failures keep the owner/cache exactly as it was.
    cached.source = source; cached.bytes = bytes;
    cached.section = local.take(); cached.view = initialView.take();
  }
  return result;
}
static napi_value NAPI_CDECL readFrameCached(napi_env env, napi_callback_info info) {
  return readFrameCachedCore(env, info, false);
}
static napi_value NAPI_CDECL readFrameCachedInto(napi_env env, napi_callback_info info) {
  return readFrameCachedCore(env, info, true);
}
static napi_value NAPI_CDECL openChild(napi_env env, napi_callback_info info) {
  napi_value arguments[2]{}; size_t count = 2;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr))) return nullptr;
  if (count != 1) return fail(env, "expected_child_pid", true);
  OwnedHandle process(openOwnedChild(env, arguments[0]));
  if (!process.get()) return nullptr;
  napi_value object = nullptr;
  if (!ok(env, api.napi_create_object(env, &object))) return nullptr;
  if (!ok(env, api.napi_type_tag_object(env, object, &kChildTag))) return nullptr;
  const napi_property_descriptor properties[]{
    {"duplicate", nullptr, duplicate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readFrame", nullptr, readFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readFrameCached", nullptr, readFrameCached, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readFrameCachedInto", nullptr, readFrameCachedInto, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, closeChild, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cpuSeconds", nullptr, cpuSeconds, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (!ok(env, api.napi_define_properties(env, object, 6, properties))) return nullptr;
  auto* owned = new (std::nothrow) ChildOwner(process.get());
  if (!owned) return fail(env, "native_handle_allocation_failed");
  process.take();
  if (!ok(env, api.napi_wrap(env, object, owned, finalizeChild, nullptr, nullptr))) { delete owned; return nullptr; }
  return object;
}
// Convenience compatibility path. Streaming callers must retain openChild()
// once per session and use its duplicate() so enumeration is not per frame.
static napi_value NAPI_CDECL duplicateFromChild(napi_env env, napi_callback_info info) {
  napi_value arguments[3]{}; size_t count = 3;
  if (!ok(env, api.napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr))) return nullptr;
  if (count != 2) return fail(env, "expected_child_pid_and_source_handle", true);
  OwnedHandle process(openOwnedChild(env, arguments[0]));
  if (!process.get()) return nullptr;
  return duplicateResource(env, process, arguments[1]);
}
NAPI_MODULE_INIT() {
  static_assert(sizeof(void*) == 8, "Native screen handles require Windows x64");
  InitOnceExecuteOnce(&apiOnce, loadApi, nullptr, nullptr);
  if (!api.ready) {
    if (api.napi_throw_error) api.napi_throw_error(env, nullptr, "native_handle_api_unavailable");
    return nullptr;
  }
  napi_value cpuFrames = nullptr, cachedCpuFrames = nullptr, pooledCpuFrames = nullptr;
  if (!ok(env, api.napi_get_boolean(env, true, &cpuFrames))) return nullptr;
  if (!ok(env, api.napi_get_boolean(env, compareObjectHandles != nullptr, &cachedCpuFrames))) return nullptr;
  if (!ok(env, api.napi_get_boolean(env, supportsCachedCpuFramesInto(), &pooledCpuFrames))) return nullptr;
  const napi_property_descriptor properties[]{
    {"openChild", nullptr, openChild, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"duplicateFromChild", nullptr, duplicateFromChild, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"supportsCpuFrames", nullptr, nullptr, nullptr, nullptr, cpuFrames, napi_enumerable, nullptr},
    {"supportsCachedCpuFrames", nullptr, nullptr, nullptr, nullptr, cachedCpuFrames, napi_enumerable, nullptr},
    {"supportsCachedCpuFramesInto", nullptr, nullptr, nullptr, nullptr, pooledCpuFrames, napi_enumerable, nullptr},
  };
  if (!ok(env, api.napi_define_properties(env, exports, 5, properties))) return nullptr;
  return exports;
}
