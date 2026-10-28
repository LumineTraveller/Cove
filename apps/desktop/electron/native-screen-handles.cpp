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
#include <new>

#define API_FUNCTIONS(X) \
  X(napi_get_cb_info) X(napi_typeof) X(napi_get_value_double) \
  X(napi_is_buffer) X(napi_get_buffer_info) X(napi_create_object) \
  X(napi_create_buffer_copy) X(napi_create_double) X(napi_define_properties) X(napi_wrap) X(napi_unwrap) \
  X(napi_get_undefined) X(napi_throw_error) X(napi_throw_type_error) \
  X(napi_type_tag_object) X(napi_check_object_type_tag)
struct Api {
#define FIELD(name) decltype(&::name) name = nullptr;
  API_FUNCTIONS(FIELD)
#undef FIELD
  bool ready = false;
};
static Api api;
static INIT_ONCE apiOnce = INIT_ONCE_STATIC_INIT;
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
static OwnedHandle* unwrap(napi_env env, napi_value object, const napi_type_tag& tag) {
  bool tagged = false;
  if (!ok(env, api.napi_check_object_type_tag(env, object, &tag, &tagged))) return nullptr;
  if (!tagged) { fail(env, "invalid_native_handle_owner", true); return nullptr; }
  void* data = nullptr;
  if (!ok(env, api.napi_unwrap(env, object, &data))) return nullptr;
  if (!data) { fail(env, "invalid_native_handle_owner", true); return nullptr; }
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
  return closeOwner(env, info, kChildTag);
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
    {"close", nullptr, closeChild, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cpuSeconds", nullptr, cpuSeconds, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (!ok(env, api.napi_define_properties(env, object, 3, properties))) return nullptr;
  auto* owned = new (std::nothrow) OwnedHandle(process.get());
  if (!owned) return fail(env, "native_handle_allocation_failed");
  process.take();
  if (!ok(env, api.napi_wrap(env, object, owned, finalize, nullptr, nullptr))) { delete owned; return nullptr; }
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
  const napi_property_descriptor properties[]{
    {"openChild", nullptr, openChild, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"duplicateFromChild", nullptr, duplicateFromChild, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  if (!ok(env, api.napi_define_properties(env, exports, 2, properties))) return nullptr;
  return exports;
}
