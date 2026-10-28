#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

// Synthetic scheduling diagnostic only. No capture, GPU, networking, global
// timer-resolution changes, process priority changes or spin waiting.
namespace {
constexpr unsigned kFps = 120;
constexpr DWORD kJoinGraceMs = 200;
constexpr DWORD kJoinCancelMs = 200;

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE input = nullptr) : value(input) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};

void error(const char* code) {
  // Fixed, bounded diagnostic codes only; never print PID, handles or arguments.
  const HANDLE destination = GetStdHandle(STD_ERROR_HANDLE);
  DWORD written = 0;
  if (destination && destination != INVALID_HANDLE_VALUE)
    WriteFile(destination, code, static_cast<DWORD>(std::strlen(code)), &written, nullptr);
}

bool writeAll(HANDLE destination, const char* bytes, DWORD length) {
  DWORD offset = 0;
  while (offset < length) {
    DWORD written = 0;
    if (!WriteFile(destination, bytes + offset, length - offset, &written, nullptr) || written == 0) return false;
    offset += written;
  }
  return true;
}

bool decimal(const char* text, unsigned long long maximum, unsigned long long& value) {
  if (!text || !*text) return false;
  for (const char* cursor = text; *cursor; ++cursor) if (*cursor < '0' || *cursor > '9') return false;
  errno = 0; char* end = nullptr;
  value = std::strtoull(text, &end, 10);
  return errno == 0 && end && *end == '\0' && value > 0 && value <= maximum;
}

struct Configuration { DWORD ownerPid = 0; unsigned seconds = 0; };
bool configuration(int argc, char** argv, Configuration& value) {
  if (argc != 5) return false;
  bool ownerSeen = false, secondsSeen = false;
  for (int index = 1; index < argc; index += 2) {
    unsigned long long parsed = 0;
    if (std::strcmp(argv[index], "--owner-pid") == 0 && !ownerSeen &&
        decimal(argv[index + 1], MAXDWORD, parsed)) {
      value.ownerPid = static_cast<DWORD>(parsed); ownerSeen = true;
    } else if (std::strcmp(argv[index], "--seconds") == 0 && !secondsSeen &&
               decimal(argv[index + 1], 35, parsed) && parsed >= 2) {
      value.seconds = static_cast<unsigned>(parsed); secondsSeen = true;
    } else return false;
  }
  return ownerSeen && secondsSeen && value.ownerPid != GetCurrentProcessId();
}

long long qpc() {
  LARGE_INTEGER counter{};
  return QueryPerformanceCounter(&counter) ? counter.QuadPart : -1;
}
double microseconds(long long ticks, long long frequency) {
  return 1000000.0 * static_cast<double>(ticks) / static_cast<double>(frequency);
}
std::uint64_t filetime(const FILETIME& value) {
  return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
struct CpuTime { std::uint64_t user = 0, kernel = 0; };
bool cpuTime(CpuTime& result) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return false;
  result.user = filetime(user); result.kernel = filetime(kernel); return true;
}

struct Tick { unsigned seq = 0; double elapsedUs = 0, lateUs = 0; };
struct Writer {
  HANDLE output;
  Handle wake{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
  Handle failed{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Handle ready{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Handle thread;
  CRITICAL_SECTION lock{};
  Tick latest{};
  bool pending = false;
  std::atomic<bool> stopping{false};
  std::atomic<unsigned> written{0};
  unsigned lastWrittenSeq = 0;
  bool joined = true;

  explicit Writer(HANDLE destination) : output(destination) { InitializeCriticalSection(&lock); }
  ~Writer() {
    // Every started thread is explicitly joined before its context can die.
    if (!joined) { error("pacer_writer_unjoined\n"); ExitProcess(2); }
    DeleteCriticalSection(&lock);
  }
  Writer(const Writer&) = delete;
  Writer& operator=(const Writer&) = delete;

  static DWORD WINAPI entry(void* pointer) { return static_cast<Writer*>(pointer)->run(); }
  DWORD run() {
    constexpr char readyLine[] = "{\"type\":\"ready\",\"fps\":120,\"highResolution\":true}\n";
    if (!writeAll(output, readyLine, static_cast<DWORD>(sizeof(readyLine) - 1))) { SetEvent(failed.value); return 2; }
    SetEvent(ready.value);
    while (!stopping.load(std::memory_order_acquire)) {
      if (WaitForSingleObject(wake.value, INFINITE) != WAIT_OBJECT_0) { SetEvent(failed.value); return 2; }
      if (stopping.load(std::memory_order_acquire)) break;
      Tick current{}; bool found = false;
      EnterCriticalSection(&lock);
      if (pending) { current = latest; pending = false; found = true; }
      LeaveCriticalSection(&lock);
      if (!found) continue;
      const unsigned skipped = current.seq - lastWrittenSeq - 1;
      char line[256]{};
      const int size = std::snprintf(line, sizeof(line),
        "{\"type\":\"tick\",\"seq\":%u,\"elapsedUs\":%.3f,\"lateUs\":%.3f,\"skipped\":%u}\n",
        current.seq, current.elapsedUs, current.lateUs, skipped);
      if (size <= 0 || static_cast<std::size_t>(size) >= sizeof(line) ||
          !writeAll(output, line, static_cast<DWORD>(size))) {
        if (!stopping.load(std::memory_order_acquire)) SetEvent(failed.value);
        return 2;
      }
      lastWrittenSeq = current.seq;
      written.fetch_add(1, std::memory_order_release);
    }
    return 0;
  }
  bool start() {
    if (!wake.valid() || !failed.valid() || !ready.valid()) return false;
    thread.value = CreateThread(nullptr, 0, entry, this, 0, nullptr);
    if (!thread.valid()) return false;
    joined = false; return true;
  }
  void put(const Tick& tick) {
    EnterCriticalSection(&lock); latest = tick; pending = true; LeaveCriticalSection(&lock);
    SetEvent(wake.value);
  }
  bool stopAndJoin() {
    if (joined) return true;
    stopping.store(true, std::memory_order_release); SetEvent(wake.value);
    DWORD status = WaitForSingleObject(thread.value, kJoinGraceMs);
    if (status == WAIT_TIMEOUT) {
      // A parent that stops reading stdout must not trap this process in a
      // synchronous pipe write. Only this process's owned writer is cancelled.
      CancelSynchronousIo(thread.value);
      status = WaitForSingleObject(thread.value, kJoinCancelMs);
    }
    joined = status == WAIT_OBJECT_0;
    if (!joined) { error("pacer_writer_join_timeout\n"); ExitProcess(2); }
    return joined;
  }
};

enum class Input { Continue, Stop, Error };
Input checkInput(HANDLE input, std::string& pending) {
  DWORD available = 0;
  if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr))
    return GetLastError() == ERROR_BROKEN_PIPE ? Input::Stop : Input::Error;
  if (!available) return Input::Continue;
  if (available > 32 || pending.size() + available > 32) return Input::Error;
  char bytes[32]{}; DWORD read = 0;
  if (!ReadFile(input, bytes, available, &read, nullptr) || read == 0)
    return GetLastError() == ERROR_BROKEN_PIPE ? Input::Stop : Input::Error;
  pending.append(bytes, read);
  const auto end = pending.find('\n');
  if (end == std::string::npos) return Input::Continue;
  if (end + 1 != pending.size()) return Input::Error;
  const std::string line = pending.substr(0, end);
  return line == "stop" || line == "stop\r" ? Input::Stop : Input::Error;
}

struct ReportWrite { HANDLE output; const char* bytes; DWORD length; bool successful = false; };
DWORD WINAPI reportEntry(void* pointer) {
  auto* value = static_cast<ReportWrite*>(pointer);
  value->successful = writeAll(value->output, value->bytes, value->length);
  return value->successful ? 0 : 2;
}
bool boundedReport(HANDLE output, const char* bytes, DWORD length) {
  ReportWrite report{output, bytes, length};
  Handle thread(CreateThread(nullptr, 0, reportEntry, &report, 0, nullptr));
  if (!thread.valid()) return false;
  DWORD status = WaitForSingleObject(thread.value, 500);
  if (status == WAIT_TIMEOUT) {
    CancelSynchronousIo(thread.value); status = WaitForSingleObject(thread.value, kJoinCancelMs);
  }
  if (status != WAIT_OBJECT_0) { error("pacer_report_join_timeout\n"); ExitProcess(2); }
  return report.successful;
}

int run(int argc, char** argv) {
  Configuration config{};
  if (!configuration(argc, argv, config)) { error("pacer_arguments_invalid\n"); return 2; }
  Handle owner(OpenProcess(SYNCHRONIZE, FALSE, config.ownerPid));
  if (!owner.valid() || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) { error("pacer_owner_unavailable\n"); return 2; }
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (GetFileType(input) != FILE_TYPE_PIPE || GetFileType(output) != FILE_TYPE_PIPE) { error("pacer_owned_pipes_required\n"); return 2; }
  LARGE_INTEGER frequency{};
  if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0) { error("pacer_qpc_unavailable\n"); return 2; }
  Handle timer(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_MODIFY_STATE | SYNCHRONIZE));
  if (!timer.valid()) { error("pacer_high_resolution_timer_unavailable\n"); return 2; }
  Writer writer(output);
  if (!writer.start()) { error("pacer_writer_start_failed\n"); return 2; }
  HANDLE readyHandles[] = {owner.value, writer.failed.value, writer.ready.value};
  const DWORD startup = WaitForMultipleObjects(3, readyHandles, FALSE, 500);
  if (startup != WAIT_OBJECT_0 + 2) {
    writer.stopAndJoin(); error("pacer_writer_ready_failed\n"); return 2;
  }
  CpuTime cpuBefore{}, cpuAfter{};
  if (!cpuTime(cpuBefore)) { writer.stopAndJoin(); error("pacer_cpu_time_unavailable\n"); return 2; }
  const long long start = qpc();
  if (start < 0) { writer.stopAndJoin(); error("pacer_qpc_failed\n"); return 2; }
  const unsigned totalPhases = config.seconds * kFps;
  unsigned nextPhase = 1, finalSeq = 0;
  const char* reason = "duration";
  const char* failure = nullptr;
  std::string inputPending;
  HANDLE waitHandles[] = {owner.value, writer.failed.value, timer.value};
  while (nextPhase <= totalPhases) {
    const Input command = checkInput(input, inputPending);
    if (command != Input::Continue) { if (command == Input::Error) failure = "pacer_input_invalid\n"; reason = "stop"; break; }
    long long now = qpc();
    if (now < start) { failure = "pacer_qpc_failed\n"; break; }
    // Absolute QPC phase; relative one-shot wait durations are re-derived from
    // this origin. A late wake drops old phases rather than drifting or bursting.
    const long long due = start + static_cast<long long>((static_cast<long long>(nextPhase) * frequency.QuadPart + kFps - 1) / kFps);
    if (now < due) {
      const long long remaining = due - now;
      const long long hundredNs = std::max(1LL, (remaining * 10000000LL + frequency.QuadPart - 1) / frequency.QuadPart);
      LARGE_INTEGER relative{}; relative.QuadPart = -hundredNs;
      if (!SetWaitableTimerEx(timer.value, &relative, 0, nullptr, nullptr, nullptr, 0)) { failure = "pacer_timer_arm_failed\n"; break; }
      const DWORD waited = WaitForMultipleObjects(3, waitHandles, FALSE, 1000);
      if (waited == WAIT_OBJECT_0) { reason = "owner_exit"; break; }
      if (waited == WAIT_OBJECT_0 + 1) { failure = "pacer_writer_failed\n"; break; }
      if (waited != WAIT_OBJECT_0 + 2) { failure = "pacer_timer_wait_failed\n"; break; }
      continue; // Recheck input, owner and the exact QPC deadline after wake.
    }
    if (WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) { reason = "owner_exit"; break; }
    const unsigned newestDue = static_cast<unsigned>(std::min<long long>(totalPhases, (now - start) * kFps / frequency.QuadPart));
    const unsigned seq = std::max(nextPhase, newestDue);
    const long long phaseDue = start + (static_cast<long long>(seq) * frequency.QuadPart + kFps - 1) / kFps;
    writer.put(Tick{seq, microseconds(now - start, frequency.QuadPart), microseconds(now - phaseDue, frequency.QuadPart)});
    finalSeq = seq; nextPhase = seq + 1;
  }
  const long long ended = qpc();
  CancelWaitableTimer(timer.value);
  // Give the final submitted tick a bounded chance to drain on a normal run.
  // This uses an event wait, never a spin loop or a global timer adjustment.
  if (!failure && std::strcmp(reason, "duration") == 0) {
    const ULONGLONG deadline = GetTickCount64() + 100;
    while (writer.written.load(std::memory_order_acquire) < totalPhases && GetTickCount64() < deadline) {
      if (WaitForSingleObject(writer.failed.value, 1) == WAIT_OBJECT_0) break;
      EnterCriticalSection(&writer.lock);
      const bool pending = writer.pending;
      LeaveCriticalSection(&writer.lock);
      if (!pending) break;
    }
  }
  writer.stopAndJoin();
  if (!cpuTime(cpuAfter)) failure = "pacer_cpu_time_unavailable\n";
  if (failure || ended < start) { error(failure ? failure : "pacer_qpc_failed\n"); return 2; }
  const unsigned written = writer.written.load(std::memory_order_acquire);
  const unsigned skipped = finalSeq >= written ? finalSeq - written : 0;
  char done[512]{};
  const int doneSize = std::snprintf(done, sizeof(done),
    "{\"type\":\"done\",\"ticks\":%u,\"skipped\":%u,\"elapsedUs\":%.3f,\"cpuUserUs\":%.3f,\"cpuKernelUs\":%.3f,\"reason\":\"%s\",\"writerJoined\":true}\n",
    written, skipped, microseconds(ended - start, frequency.QuadPart),
    static_cast<double>(cpuAfter.user - cpuBefore.user) / 10.0,
    static_cast<double>(cpuAfter.kernel - cpuBefore.kernel) / 10.0, reason);
  if (doneSize <= 0 || static_cast<std::size_t>(doneSize) >= sizeof(done)) { error("pacer_report_invalid\n"); return 2; }
  if (!boundedReport(output, done, static_cast<DWORD>(doneSize))) {
    if (std::strcmp(reason, "owner_exit") != 0) { error("pacer_report_write_failed\n"); return 2; }
  }
  return 0;
}
} // namespace

int main(int argc, char** argv) {
  try { return run(argc, argv); }
  catch (...) { error("pacer_internal_failed\n"); return 2; }
}
