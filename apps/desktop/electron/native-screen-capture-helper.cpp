// Experimental Windows capture provider. GPU sharing remains the default. The
// explicit CPU/NV12 backend owns three bounded sections; no encoder, image pipe,
// OS timer change, restart loop or automatic source fallback is involved.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <d3d11_4.h>
#include <d3dcompiler.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
constexpr uint64_t kSafeInteger = 9007199254740991ULL;
constexpr UINT kMaxDimension = 16384;
constexpr UINT kMaxCursorDimension = 512;
constexpr UINT kMaxCursorBytes = kMaxCursorDimension * kMaxCursorDimension * 8;
constexpr size_t kMaxCpuFrameBytes = 16 * 1024 * 1024;
class Failure final : public std::exception {
  const char* code_;
public:
  explicit Failure(const char* code) : code_(code) {}
  const char* what() const noexcept override { return code_; }
};
static void require(bool value, const char* code) { if (!value) throw Failure(code); }
static void check(HRESULT value, const char* code) { require(SUCCEEDED(value), code); }

struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Size { UINT width, height; };
static size_t tightNv12ByteLength(Size size) {
  require(size.width >= 2 && size.height >= 2 && size.width <= kMaxDimension && size.height <= kMaxDimension &&
    size.width % 2 == 0 && size.height % 2 == 0, "invalid_cpu_frame_layout");
  const uint64_t bytes = uint64_t(size.width) * size.height * 3 / 2;
  require(bytes <= kMaxCpuFrameBytes, "cpu_frame_too_large");
  return size_t(bytes);
}
// RowPitch belongs to D3D; the section has a separate, tightly packed contract.
// The UV plane starts after all padded Y rows in the mapped NV12 texture.
static void copyNv12Rows(const D3D11_MAPPED_SUBRESOURCE& source, Size size,
    unsigned char* destination, size_t byteLength) {
  require(source.pData && destination && source.RowPitch >= size.width &&
    byteLength == tightNv12ByteLength(size), "invalid_cpu_frame_layout");
  const auto* y = static_cast<const unsigned char*>(source.pData);
  const auto* uv = y + size_t(source.RowPitch) * size.height;
  for (UINT row = 0; row < size.height; ++row)
    std::memcpy(destination + size_t(row) * size.width, y + size_t(row) * source.RowPitch, size.width);
  const size_t yBytes = size_t(size.width) * size.height;
  for (UINT row = 0; row < size.height / 2; ++row)
    std::memcpy(destination + yBytes + size_t(row) * size.width, uv + size_t(row) * source.RowPitch, size.width);
}
static Size scaledSize(UINT width, UINT height, UINT maxWidth, UINT maxHeight) {
  require(width >= 2 && height >= 2 && width <= kMaxDimension && height <= kMaxDimension &&
    maxWidth >= 2 && maxHeight >= 2 && maxWidth <= kMaxDimension && maxHeight <= kMaxDimension,
    "invalid_dimensions");
  // One common scale, full image, floor to even; never enlarge either dimension.
  const double scale = std::min({1.0, double(maxWidth) / width, double(maxHeight) / height});
  const UINT w = UINT(std::floor(width * scale + 1e-9)) / 2 * 2;
  const UINT h = UINT(std::floor(height * scale + 1e-9)) / 2 * 2;
  require(w >= 2 && h >= 2 && w <= width && h <= height && w <= maxWidth && h <= maxHeight,
    "invalid_scaled_dimensions");
  return {w, h};
}
static uint64_t decimal(const std::string& text, uint64_t maximum, const char* code) {
  require(!text.empty() && text.size() <= 16, code);
  uint64_t value = 0;
  for (char ch : text) {
    require(ch >= '0' && ch <= '9', code);
    const unsigned digit = unsigned(ch - '0');
    require(value <= maximum / 10 && (value < maximum / 10 || digit <= maximum % 10), code);
    value = value * 10 + digit;
  }
  require(value <= maximum, code);
  return value;
}
enum class CompletionMode { Query, Fence };
static const char* completionName(CompletionMode mode) { return mode == CompletionMode::Fence ? "fence" : "query"; }
struct Options {
  DWORD owner = 0; UINT maxWidth = 0, maxHeight = 0, fps = 0;
  bool nv12 = false, cpu = false;
  CompletionMode completion = CompletionMode::Query;
};
static Options options(int argc, char** argv) {
  require(argc >= 9 && argc <= 15 && argc % 2 == 1, "invalid_arguments");
  Options result;
  unsigned seen = 0;
  for (int i = 1; i < argc; i += 2) {
    const std::string name(argv[i]);
    unsigned bit = 0;
    if (name == "--owner-pid") {
      bit = 1; result.owner = DWORD(decimal(argv[i + 1], MAXDWORD, "invalid_arguments"));
    } else if (name == "--max-width") {
      bit = 2; result.maxWidth = UINT(decimal(argv[i + 1], kMaxDimension, "invalid_arguments"));
    } else if (name == "--max-height") {
      bit = 4; result.maxHeight = UINT(decimal(argv[i + 1], kMaxDimension, "invalid_arguments"));
    } else if (name == "--fps") {
      bit = 8; result.fps = UINT(decimal(argv[i + 1], 120, "invalid_arguments"));
    } else if (name == "--pixel-format") {
      bit = 16; require(std::string(argv[i + 1]) == "nv12", "invalid_arguments"); result.nv12 = true;
    } else if (name == "--frame-storage") {
      bit = 32; require(std::string(argv[i + 1]) == "cpu", "invalid_arguments"); result.cpu = true;
    } else if (name == "--completion") {
      bit = 64; const std::string value(argv[i + 1]);
      require(value == "query" || value == "fence", "invalid_arguments");
      result.completion = value == "fence" ? CompletionMode::Fence : CompletionMode::Query;
    } else require(false, "invalid_arguments");
    require(!(seen & bit), "invalid_arguments"); seen |= bit;
  }
  require((!result.cpu || result.nv12) && (seen & ~64U) == ((result.nv12 ? 31U : 15U) | (result.cpu ? 32U : 0U)) &&
    result.owner && result.maxWidth >= 2 && result.maxHeight >= 2 &&
    (result.fps == 30 || result.fps == 60 || result.fps == 120), "invalid_arguments");
  return result;
}
static DWORD parentPid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.value != INVALID_HANDLE_VALUE, "owner_snapshot_failed");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.value, &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.value, &entry));
  throw Failure("owner_not_found");
}
static bool ownerAlive(HANDLE owner) { return WaitForSingleObject(owner, 0) == WAIT_TIMEOUT; }
struct Clock {
  LONGLONG frequency = 0, begin = 0;
  Clock() {
    LARGE_INTEGER value{}; require(QueryPerformanceFrequency(&value) && value.QuadPart > 0, "clock_unavailable");
    frequency = value.QuadPart;
    require(QueryPerformanceCounter(&value), "clock_unavailable"); begin = value.QuadPart;
  }
  uint64_t us() const {
    LARGE_INTEGER value{}; require(QueryPerformanceCounter(&value), "clock_unavailable");
    const LONGLONG elapsed = value.QuadPart - begin;
    require(elapsed >= 0, "clock_regressed");
    return uint64_t(elapsed / frequency) * 1000000 + uint64_t(elapsed % frequency) * 1000000 / uint64_t(frequency);
  }
};
// First strictly future tick on the existing phase. Coalesce missed deadlines
// without replaying captures. A late tick may be close to the next phase tick;
// this does not impose a minimum inter-frame interval or fabricate old frames.
static uint64_t advanceTick(uint64_t due, uint64_t now, uint64_t period) {
  require(period > 0, "invalid_capture_period");
  if (now < due) return due;
  const uint64_t gap = period - (now - due) % period;
  require(now <= std::numeric_limits<uint64_t>::max() - gap, "capture_deadline_exhausted");
  return now + gap;
}
// Opt-in, bounded cumulative timings. No per-frame records or desktop metadata
// are retained, and the normal stdout protocol is never used for diagnostics.
struct StageTiming {
  uint64_t count = 0, totalUs = 0, maxUs = 0;
  void add(uint64_t elapsed) { ++count; totalUs += elapsed; maxUs = std::max(maxUs, elapsed); }
};
struct CaptureTiming {
  enum Stage { Acquire, Draw, GpuWait, GpuFlush, GpuQuery, FrameRelease, Output,
    TickWork, TickLateness, TimerWait, TimerOvershoot, SlotCreditWait, CpuReadback,
    GpuFenceCheck, GpuEventArm, GpuEventWait, CpuMapWait, StageCount };
  bool enabled = false;
  CompletionMode selectedCompletion = CompletionMode::Query;
  uint64_t begin = 0, nextReport = 0, creditWaitBegin = 0, periodUs = 0;
  uint64_t ticks = 0, missedTicks = 0, acquireSuccess = 0, acquireTimeout = 0;
  uint64_t noPresent = 0, noSlot = 0, sourcePresents = 0, pointerOnly = 0;
  uint64_t accumulatedFrames = 0, maxAccumulatedFrames = 0, newFrames = 0, refreshFrames = 0;
  uint64_t readinessRetries = 0, readinessExpired = 0, readinessCancelled = 0;
  uint64_t readinessSlotWaitWindows = 0, readinessPresentWaitWindows = 0;
  uint64_t readinessRecoveredSlot = 0, readinessRecoveredPresent = 0;
  uint64_t cpuMapAttempts = 0, cpuMapStillDrawing = 0, cpuMapCancelled = 0, cpuMapTimeouts = 0;
  std::array<StageTiming, StageCount> stages{};
  CaptureTiming() {
    wchar_t value[2]{};
    enabled = GetEnvironmentVariableW(L"COVE_NATIVE_GPU_CAPTURE_TIMING", value, 2) == 1 && value[0] == L'1';
  }
  void start(uint64_t now, uint64_t period) { begin = now; nextReport = now + 1000000; periodUs = period; }
  void report(uint64_t now, bool final = false) {
    if (!enabled || (!final && now < nextReport)) return;
    nextReport = now + 1000000;
    static constexpr const char* names[]{"acquire", "draw", "gpuWait", "gpuFlush", "gpuQuery",
      "frameRelease", "output", "tickWork", "tickLateness", "timerWait", "timerOvershoot", "slotCreditWait", "cpuReadback",
      "gpuFenceCheck", "gpuEventArm", "gpuEventWait", "cpuMapWait"};
    static_assert(sizeof(names) / sizeof(names[0]) == StageCount, "timing stage names");
    std::ostringstream out;
    out << "COVE_NATIVE_CAPTURE_TIMING {\"schemaVersion\":1,\"final\":" << (final ? "true" : "false")
      << ",\"selectedCompletion\":\"" << completionName(selectedCompletion) << '"'
      << ",\"elapsedUs\":" << now - begin << ",\"periodUs\":" << periodUs
      << ",\"ticks\":" << ticks << ",\"missedTicks\":" << missedTicks
      << ",\"acquireSuccess\":" << acquireSuccess << ",\"acquireTimeout\":" << acquireTimeout
      << ",\"noPresent\":" << noPresent << ",\"noSlot\":" << noSlot
      << ",\"sourcePresents\":" << sourcePresents << ",\"pointerOnly\":" << pointerOnly
      << ",\"accumulatedFrames\":" << accumulatedFrames << ",\"maxAccumulatedFrames\":" << maxAccumulatedFrames
      << ",\"newFrames\":" << newFrames << ",\"refreshFrames\":" << refreshFrames
      << ",\"readinessRetries\":" << readinessRetries << ",\"readinessExpired\":" << readinessExpired
      << ",\"readinessCancelled\":" << readinessCancelled
      << ",\"readinessSlotWaitWindows\":" << readinessSlotWaitWindows
      << ",\"readinessPresentWaitWindows\":" << readinessPresentWaitWindows
      << ",\"readinessRecoveredSlot\":" << readinessRecoveredSlot
      << ",\"readinessRecoveredPresent\":" << readinessRecoveredPresent
      << ",\"cpuMapAttempts\":" << cpuMapAttempts << ",\"cpuMapStillDrawing\":" << cpuMapStillDrawing
      << ",\"cpuMapCancelled\":" << cpuMapCancelled << ",\"cpuMapTimeouts\":" << cpuMapTimeouts
      << ",\"openSlotCreditWaitUs\":" << (creditWaitBegin ? now - creditWaitBegin : 0) << ",\"stages\":{";
    for (size_t i = 0; i < stages.size(); ++i) {
      if (i) out << ',';
      const auto& stage = stages[i];
      out << '\"' << names[i] << "\":{\"count\":" << stage.count << ",\"totalUs\":" << stage.totalUs
        << ",\"maxUs\":" << stage.maxUs << '}';
    }
    out << "}}\n";
    std::cerr << out.str();
  }
};
class Measure {
  const Clock& clock_;
  StageTiming* stage_ = nullptr;
  uint64_t begin_ = 0;
public:
  Measure(CaptureTiming& timing, CaptureTiming::Stage stage, const Clock& clock) : clock_(clock) {
    if (timing.enabled) { stage_ = &timing.stages[stage]; begin_ = clock.us(); }
  }
  ~Measure() { if (stage_) stage_->add(clock_.us() - begin_); }
};
// Startup is outside the capture-loop timing origin. Emit its bounded summary
// independently, including when a queued stop ends the very first loop pump.
class StartupTiming {
public:
  enum Phase { Setup, SourceLookup, Device, Pipeline, Slots, Query, ValidateOutput,
    DuplicateOutput, ReadyOutput, PhaseCount };
private:
  const Clock& clock_;
  CompletionMode selectedCompletion_;
  bool enabled_ = false, reported_ = false;
  Phase phase_ = Setup;
  uint64_t begin_ = 0, previous_ = 0;
  std::array<uint64_t, PhaseCount> stages_{};
public:
  StartupTiming(const Clock& clock, bool enabled, CompletionMode completion)
      : clock_(clock), selectedCompletion_(completion), enabled_(enabled) {
    if (enabled_) begin_ = previous_ = clock_.us();
  }
  void next(Phase phase) {
    if (!enabled_) return;
    const auto now = clock_.us();
    stages_[phase_] += now - previous_; previous_ = now; phase_ = phase;
  }
  void report(bool complete) {
    if (!enabled_ || reported_) return;
    reported_ = true;
    const auto now = clock_.us();
    stages_[phase_] += now - previous_;
    static constexpr const char* names[]{"setup", "sourceLookup", "device", "pipeline", "slots",
      "query", "validateOutput", "duplicateOutput", "readyOutput"};
    static_assert(sizeof(names) / sizeof(names[0]) == PhaseCount, "startup phase names");
    std::ostringstream out;
    out << "COVE_NATIVE_CAPTURE_STARTUP {\"schemaVersion\":1,\"complete\":" << (complete ? "true" : "false")
      << ",\"selectedCompletion\":\"" << completionName(selectedCompletion_) << '"'
      << ",\"phase\":\"" << names[phase_] << "\",\"elapsedUs\":" << now - begin_ << ",\"stages\":{";
    for (size_t i = 0; i < stages_.size(); ++i) {
      if (i) out << ',';
      out << '\"' << names[i] << "Us\":" << stages_[i];
    }
    out << "}}\n";
    std::cerr << out.str();
  }
  ~StartupTiming() {
    // On initialization failure the current phase also includes stack cleanup.
    // Diagnostics must never replace the helper's original fixed failure code.
    try { report(false); } catch (...) {}
  }
};
// A due tick owns one bounded readiness opportunity on the existing phase. An
// unavailable credit/present may become ready inside that period; it never
// creates another tick or permits a second output. Blocking API/timer requests
// are capped by the remaining budget, including the sub-millisecond tail.
class ReadinessWindow {
  uint64_t deadline_;
  bool completed_ = false, cancelled_ = false;
public:
  bool waitedSlot = false, waitedPresent = false;
  unsigned attempts = 0;
  explicit ReadinessWindow(uint64_t deadline) : deadline_(deadline) {}
  uint64_t remaining(uint64_t now) const {
    return !completed_ && !cancelled_ && now < deadline_ ? deadline_ - now : 0;
  }
  bool open(uint64_t now) const { return remaining(now) != 0; }
  UINT acquireTimeoutMs(uint64_t now) const { return UINT(std::min<uint64_t>(1, remaining(now) / 1000)); }
  uint64_t waitUs(uint64_t now, uint64_t maximum) const { return std::min(remaining(now), maximum); }
  void complete() { require(!completed_ && !cancelled_, "invalid_readiness_completion"); completed_ = true; }
  void cancel() { require(!completed_, "invalid_readiness_cancellation"); cancelled_ = true; }
};
class Timer {
  Handle handle_;
public:
  Timer() : handle_(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
      TIMER_MODIFY_STATE | SYNCHRONIZE)) { require(handle_.value != nullptr, "timer_unavailable"); }
  void wait(HANDLE owner, uint64_t us, CaptureTiming* timing = nullptr, const Clock* clock = nullptr,
      HANDLE wakeEvent = nullptr) {
    const uint64_t requested = std::max<uint64_t>(1, std::min<uint64_t>(us, 2000));
    const uint64_t begin = timing && timing->enabled ? clock->us() : 0;
    LARGE_INTEGER due{}; due.QuadPart = -LONGLONG(requested) * 10;
    require(SetWaitableTimer(handle_.value, &due, 0, nullptr, nullptr, FALSE), "timer_failed");
    // The owner is first so it wins a simultaneous owner/event/timer wake. The
    // high-resolution timer bounds command-pump latency even on a stalled GPU;
    // the GPU event can wake immediately rather than waiting out that interval.
    HANDLE objects[]{owner, wakeEvent ? wakeEvent : handle_.value, handle_.value};
    const DWORD result = WaitForMultipleObjects(wakeEvent ? 3 : 2, objects, FALSE, 100);
    require(result == WAIT_OBJECT_0 + 1 || (wakeEvent && result == WAIT_OBJECT_0 + 2),
      result == WAIT_OBJECT_0 ? "owner_exited" : "timer_failed");
    if (timing && timing->enabled) {
      const uint64_t elapsed = clock->us() - begin;
      timing->stages[CaptureTiming::TimerWait].add(elapsed);
      timing->stages[CaptureTiming::TimerOvershoot].add(elapsed > requested ? elapsed - requested : 0);
    }
  }
};

struct Lease {
  uint64_t serial = 0;
  bool busy = false, imported = false;
  void issue(uint64_t value) {
    require(!busy && value && value <= kSafeInteger, "invalid_slot_issue");
    serial = value; busy = true; imported = false;
  }
  void import(uint64_t value) {
    require(busy && !imported && value == serial, "invalid_import_ack"); imported = true;
  }
  void release(uint64_t value) {
    require(busy && imported && value == serial, "invalid_release_ack"); busy = false;
  }
};
struct CpuMappingView {
  unsigned char* value = nullptr;
  size_t byteLength = 0;
  CpuMappingView() = default;
  CpuMappingView(const CpuMappingView&) = delete;
  CpuMappingView& operator=(const CpuMappingView&) = delete;
  void open(HANDLE section, size_t bytes) {
    require(!value && bytes && bytes <= kMaxCpuFrameBytes, "invalid_cpu_frame_layout");
    value = static_cast<unsigned char*>(MapViewOfFile(section, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, bytes));
    require(value != nullptr, "cpu_shared_view_failed");
    byteLength = bytes; SecureZeroMemory(value, byteLength);
  }
  // A parent may still be synchronously copying an issued frame during owner
  // teardown. Never rewrite those leased bytes here; the unnamed section lives
  // until its last view/handle closes and the OS clears recycled pages.
  ~CpuMappingView() { if (value) UnmapViewOfFile(value); }
};
struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11RenderTargetView> target, chromaTarget;
  ComPtr<IDXGIKeyedMutex> mutex;
  Handle local;
  // Declared after the owning section handle so the view is unmapped
  // before CloseHandle. GPU slots leave both CPU fields empty.
  CpuMappingView cpuView;
  ComPtr<ID3D11Texture2D> staging;
  Lease lease;
  uint64_t sentAt = 0;
};
struct Command { enum Kind { Stop, Imported, Released } kind; UINT slot = 0; uint64_t serial = 0; };
static Command parseCommand(const std::string& line) {
  if (line == "stop") return {Command::Stop, 0, 0};
  const size_t first = line.find(' '), second = line.find(' ', first == std::string::npos ? 0 : first + 1);
  require(first != std::string::npos && second != std::string::npos &&
    line.find(' ', second + 1) == std::string::npos, "invalid_owner_command");
  Command result;
  const auto verb = line.substr(0, first);
  require(verb == "imported" || verb == "released", "invalid_owner_command");
  result.kind = verb == "imported" ? Command::Imported : Command::Released;
  result.slot = UINT(decimal(line.substr(first + 1, second - first - 1), 2, "invalid_owner_command"));
  result.serial = decimal(line.substr(second + 1), kSafeInteger, "invalid_owner_command");
  require(result.serial > 0, "invalid_owner_command");
  return result;
}
class Input {
  std::string pending_;
public:
  bool pump(HANDLE owner, std::array<Slot, 3>& slots) {
    require(ownerAlive(owner), "owner_exited");
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD count = 0;
    require(PeekNamedPipe(input, nullptr, 0, nullptr, &count, nullptr), "owner_pipe_closed");
    require(count <= 4096, "owner_command_overflow");
    if (count) {
      char data[4096]; DWORD read = 0;
      require(ReadFile(input, data, std::min<DWORD>(sizeof(data), count), &read, nullptr) && read,
        "owner_pipe_closed");
      pending_.append(data, read);
    }
    unsigned commands = 0;
    while (true) {
      const auto end = pending_.find('\n');
      if (end == std::string::npos) break;
      require(end <= 96 && ++commands <= 64, "owner_command_overflow");
      std::string line = pending_.substr(0, end); pending_.erase(0, end + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      const auto command = parseCommand(line);
      if (command.kind == Command::Stop) return false;
      auto& slot = slots[command.slot];
      if (command.kind == Command::Imported) {
        slot.lease.import(command.serial);
      } else {
        slot.lease.release(command.serial);
      }
    }
    require(pending_.size() <= 96, "owner_command_overflow");
    return true;
  }
};

struct Output {
  ComPtr<IDXGIFactory1> factory;
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  ComPtr<IDXGIOutput6> output6;
  DXGI_OUTPUT_DESC desc{};
  DISPLAYCONFIG_PATH_INFO path{};
};
static DISPLAYCONFIG_PATH_INFO singleDisplayPath() {
  UINT32 paths = 0, modes = 0;
  require(GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &paths, &modes) == ERROR_SUCCESS &&
    paths == 1 && modes > 0 && modes <= 16, "unsupported_display_topology");
  DISPLAYCONFIG_PATH_INFO path{};
  std::vector<DISPLAYCONFIG_MODE_INFO> mode(modes);
  require(QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &paths, &path, &modes, mode.data(), nullptr) == ERROR_SUCCESS &&
    paths == 1 && path.targetInfo.rotation == DISPLAYCONFIG_ROTATION_IDENTITY,
    "unsupported_display_topology");
  switch (path.targetInfo.outputTechnology) {
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HD15:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DVI:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HDMI:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EXTERNAL:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EXTERNAL:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED:
    case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL:
      break;
    default: throw Failure("unsupported_display_connection");
  }
  DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO color{};
  color.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
  color.header.size = sizeof(color); color.header.adapterId = path.targetInfo.adapterId;
  color.header.id = path.targetInfo.id;
  require(DisplayConfigGetDeviceInfo(&color.header) == ERROR_SUCCESS && !color.advancedColorEnabled &&
    !color.wideColorEnforced, "unsupported_display_color");
  return path;
}
static void validateOutputFast(const Output& output) {
  require(output.factory->IsCurrent(), "display_changed");
  require(GetSystemMetrics(SM_CMONITORS) == 1, "display_changed");
  MONITORINFO monitor{}; monitor.cbSize = sizeof(monitor);
  require(GetMonitorInfoW(output.desc.Monitor, &monitor) && (monitor.dwFlags & MONITORINFOF_PRIMARY) &&
    EqualRect(&monitor.rcMonitor, &output.desc.DesktopCoordinates), "display_changed");
  DXGI_OUTPUT_DESC1 desc{}; check(output.output6->GetDesc1(&desc), "display_query_failed");
  require(desc.AttachedToDesktop && desc.Rotation == DXGI_MODE_ROTATION_IDENTITY &&
    desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 &&
    EqualRect(&desc.DesktopCoordinates, &output.desc.DesktopCoordinates), "unsupported_display_color_or_geometry");
}
static void validateOutput(const Output& output) {
  validateOutputFast(output);
  const auto path = singleDisplayPath();
  require(path.targetInfo.id == output.path.targetInfo.id &&
    path.targetInfo.adapterId.HighPart == output.path.targetInfo.adapterId.HighPart &&
    path.targetInfo.adapterId.LowPart == output.path.targetInfo.adapterId.LowPart, "display_changed");
}
static Output primaryOutput() {
  Output result;
  result.path = singleDisplayPath();
  require(GetSystemMetrics(SM_CMONITORS) == 1, "unsupported_display_topology");
  const POINT origin{};
  const HMONITOR primary = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
  MONITORINFO monitor{}; monitor.cbSize = sizeof(monitor);
  require(primary && GetMonitorInfoW(primary, &monitor) && (monitor.dwFlags & MONITORINFOF_PRIMARY) &&
    monitor.rcMonitor.left == 0 && monitor.rcMonitor.top == 0 &&
    monitor.rcMonitor.right >= monitor.rcMonitor.bottom, "unsupported_display_geometry");
  check(CreateDXGIFactory1(IID_PPV_ARGS(result.factory.GetAddressOf())), "factory_failed");
  unsigned attached = 0;
  for (UINT ai = 0;; ++ai) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT ar = result.factory->EnumAdapters1(ai, adapter.GetAddressOf());
    if (ar == DXGI_ERROR_NOT_FOUND) break;
    check(ar, "adapter_query_failed");
    for (UINT oi = 0;; ++oi) {
      ComPtr<IDXGIOutput> output;
      const HRESULT hr = adapter->EnumOutputs(oi, output.GetAddressOf());
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      check(hr, "output_query_failed");
      DXGI_OUTPUT_DESC desc{}; check(output->GetDesc(&desc), "output_query_failed");
      if (!desc.AttachedToDesktop) continue;
      ++attached;
      if (desc.Monitor != primary) continue;
      require(!result.output, "ambiguous_primary_output");
      result.adapter = adapter; result.desc = desc;
      check(output.As(&result.output), "unsupported_output_api");
      check(output.As(&result.output6), "unsupported_output_api");
    }
  }
  require(attached == 1 && result.output, "unsupported_display_topology");
  validateOutput(result);
  return result;
}

struct CursorShape {
  UINT width = 0, height = 0, type = 0;
  // Small UINT texture only. COLOR/MASKED retain BGRA bytes; MONO expands each
  // pixel to (AND byte, XOR byte, 0, 0). Padding and HotSpot are not uploaded.
  std::vector<unsigned char> bytes;
  ~CursorShape() { if (!bytes.empty()) SecureZeroMemory(bytes.data(), bytes.size()); }
};
static CursorShape decodeCursor(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& info,
    const unsigned char* raw, size_t length) {
  require(info.Width && info.Width <= kMaxCursorDimension && info.Height &&
    info.Height <= kMaxCursorDimension * 2 && raw &&
    uint64_t(info.Pitch) * info.Height <= length, "unsupported_cursor_shape");
  CursorShape shape; shape.width = info.Width; shape.height = info.Height; shape.type = info.Type;
  if (info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
    require(info.Height % 2 == 0 && info.Pitch >= (info.Width + 7) / 8, "unsupported_cursor_shape");
    shape.height /= 2;
  } else {
    require((info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR ||
      info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) &&
      info.Pitch >= uint64_t(info.Width) * 4 && info.Height <= kMaxCursorDimension,
      "unsupported_cursor_shape");
  }
  shape.bytes.resize(size_t(shape.width) * shape.height * 4);
  for (UINT y = 0; y < shape.height; ++y) for (UINT x = 0; x < shape.width; ++x) {
    auto* out = shape.bytes.data() + (size_t(y) * shape.width + x) * 4;
    if (shape.type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
      const unsigned char bit = 0x80 >> (x % 8);
      out[0] = (raw[size_t(y) * info.Pitch + x / 8] & bit) ? 255 : 0;
      out[1] = (raw[size_t(y + shape.height) * info.Pitch + x / 8] & bit) ? 255 : 0;
      out[2] = out[3] = 0;
    } else {
      std::memcpy(out, raw + size_t(y) * info.Pitch + x * 4, 4);
      require(shape.type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR || out[3] == 0 || out[3] == 255,
        "unsupported_cursor_shape");
    }
  }
  return shape;
}

// Exact area coverage in each axis, in gamma-encoded UNORM space like a CPU box
// scaler. No bilinear shortcut. Cursor operations happen on source texels before
// horizontal integration, so XOR/masks and cursor edges scale with the image.
// Half-float intermediate avoids a second 8-bit rounding; final output is BGRA8.
static const char* kShader = R"HLSL(
cbuffer Params : register(b0) {
  uint sourceWidth, sourceHeight, targetWidth, targetHeight;
  int cursorX, cursorY; uint cursorWidth, cursorHeight;
  uint cursorType, cursorVisible, reserved0, reserved1;
};
Texture2D<float4> image : register(t0);
Texture2D<uint4> cursor : register(t1);
struct Vertex { float4 position : SV_Position; };
Vertex vertexMain(uint id : SV_VertexID) {
  Vertex v;
  float2 uv = float2((id << 1) & 2, id & 2);
  v.position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
  return v;
}
float4 sourcePixel(int2 p) {
  float4 base = image.Load(int3(p, 0));
  int2 cp = p - int2(cursorX, cursorY);
  if (cursorVisible == 0 || any(cp < 0) || cp.x >= int(cursorWidth) || cp.y >= int(cursorHeight)) return base;
  uint4 c = cursor.Load(int3(cp, 0));
  uint3 b = uint3(round(saturate(base.rgb) * 255));
  if (cursorType == 1) base.rgb = float3((b & c.xxx) ^ c.yyy) / 255;
  else if (cursorType == 4) base.rgb = float3(c.a == 0 ? c.zyx : (b ^ c.zyx)) / 255;
  else { float alpha = float(c.a) / 255; base.rgb = float3(c.zyx) / 255 * alpha + base.rgb * (1 - alpha); }
  return base;
}
float4 horizontalMain(Vertex v) : SV_Target {
  int2 p = int2(v.position.xy);
  float lo = float(p.x) * float(sourceWidth) / float(targetWidth);
  float hi = float(p.x + 1) * float(sourceWidth) / float(targetWidth);
  float4 sum = 0;
  [loop] for (int x = int(floor(lo)); x < min(int(ceil(hi)), int(sourceWidth)); ++x) {
    float weight = max(0.0, min(hi, float(x + 1)) - max(lo, float(x)));
    sum += sourcePixel(int2(x, p.y)) * weight;
  }
  return sum / (hi - lo);
}
float4 verticalMain(Vertex v) : SV_Target {
  int2 p = int2(v.position.xy);
  float lo = float(p.y) * float(sourceHeight) / float(targetHeight);
  float hi = float(p.y + 1) * float(sourceHeight) / float(targetHeight);
  float4 sum = 0;
  [loop] for (int y = int(floor(lo)); y < min(int(ceil(hi)), int(sourceHeight)); ++y) {
    float weight = max(0.0, min(hi, float(y + 1)) - max(lo, float(y)));
    sum += image.Load(int3(p.x, y, 0)) * weight;
  }
  return sum / (hi - lo);
}
// Optional output conversion samples the existing, fully composed BGRA8 area
// result. Values stay gamma encoded; REC709 limited metadata accompanies NV12.
float3 nv12Convert709(float3 rgb) {
  float y = dot(rgb, float3(.2126, .7152, .0722));
  return float3(16 + 219 * y, 128 + 224 * (rgb.b - y) / (2 * (1 - .0722)),
    128 + 224 * (rgb.r - y) / (2 * (1 - .2126))) / 255;
}
float4 nv12LumaMain(Vertex v) : SV_Target {
  float3 rgb = image.Load(int3(int2(v.position.xy), 0)).rgb;
  return float4(nv12Convert709(rgb).x, 0, 0, 1);
}
float4 nv12ChromaMain(Vertex v) : SV_Target {
  int2 p = int2(v.position.xy) * 2;
  float3 rgb = (image.Load(int3(p, 0)).rgb + image.Load(int3(p + int2(1,0), 0)).rgb
    + image.Load(int3(p + int2(0,1), 0)).rgb + image.Load(int3(p + int2(1,1), 0)).rgb) * .25;
  return float4(nv12Convert709(rgb).yz, 0, 1);
}
)HLSL";
static ComPtr<ID3DBlob> compile(const char* entry, const char* target) {
  ComPtr<ID3DBlob> code, errors;
  check(D3DCompile(kShader, std::strlen(kShader), "cove-native-area", nullptr, nullptr, entry, target,
    D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
    code.GetAddressOf(), errors.GetAddressOf()), "shader_compile_failed");
  return code;
}
static D3D11_TEXTURE2D_DESC textureDesc(UINT width, UINT height, DXGI_FORMAT format, UINT bindings) {
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width; desc.Height = height; desc.MipLevels = 1; desc.ArraySize = 1;
  desc.Format = format; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = bindings;
  return desc;
}
struct Constants {
  UINT sourceWidth, sourceHeight, targetWidth, targetHeight;
  INT cursorX = 0, cursorY = 0;
  UINT cursorWidth = 0, cursorHeight = 0, cursorType = 0, cursorVisible = 0, reserved0 = 0, reserved1 = 0;
};
static_assert(sizeof(Constants) == 48, "HLSL constant buffer layout");
class Pipeline {
  ComPtr<ID3D11VertexShader> vertex_;
  ComPtr<ID3D11PixelShader> horizontal_, vertical_, luma_, chroma_;
  ComPtr<ID3D11Buffer> constants_;
  ComPtr<ID3D11RasterizerState> rasterizer_;
  ComPtr<ID3D11DepthStencilState> depth_;
  ComPtr<ID3D11ShaderResourceView> sourceView_, intermediateView_, cursorView_;
  ComPtr<ID3D11RenderTargetView> intermediateTarget_;
  ComPtr<ID3D11Texture2D> intermediate_, cursorTexture_;
  ComPtr<ID3D11Texture2D> nv12Scratch_;
  ComPtr<ID3D11ShaderResourceView> nv12ScratchView_;
  ComPtr<ID3D11RenderTargetView> nv12ScratchTarget_;
  std::vector<unsigned char> cursorBytes_;
public:
  ComPtr<ID3D11Texture2D> desktop;
  Constants values;
  Pipeline(ID3D11Device* device, Size source, Size target, bool nv12 = false)
      : values{source.width, source.height, target.width, target.height} {
    auto desc = textureDesc(source.width, source.height, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_SHADER_RESOURCE);
    check(device->CreateTexture2D(&desc, nullptr, desktop.GetAddressOf()), "desktop_texture_failed");
    check(device->CreateShaderResourceView(desktop.Get(), nullptr, sourceView_.GetAddressOf()), "source_view_failed");
    desc = textureDesc(target.width, source.height, DXGI_FORMAT_R16G16B16A16_FLOAT,
      D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET);
    check(device->CreateTexture2D(&desc, nullptr, intermediate_.GetAddressOf()), "intermediate_texture_failed");
    check(device->CreateShaderResourceView(intermediate_.Get(), nullptr, intermediateView_.GetAddressOf()), "intermediate_view_failed");
    check(device->CreateRenderTargetView(intermediate_.Get(), nullptr, intermediateTarget_.GetAddressOf()), "intermediate_target_failed");
    const auto vertex = compile("vertexMain", "vs_4_0"), horizontal = compile("horizontalMain", "ps_4_0"),
      vertical = compile("verticalMain", "ps_4_0");
    check(device->CreateVertexShader(vertex->GetBufferPointer(), vertex->GetBufferSize(), nullptr,
      vertex_.GetAddressOf()), "vertex_shader_failed");
    check(device->CreatePixelShader(horizontal->GetBufferPointer(), horizontal->GetBufferSize(), nullptr,
      horizontal_.GetAddressOf()), "pixel_shader_failed");
    check(device->CreatePixelShader(vertical->GetBufferPointer(), vertical->GetBufferSize(), nullptr,
      vertical_.GetAddressOf()), "pixel_shader_failed");
    if (nv12) {
      require(target.width % 2 == 0 && target.height % 2 == 0, "invalid_nv12_dimensions");
      desc = textureDesc(target.width, target.height, DXGI_FORMAT_B8G8R8A8_UNORM,
        D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET);
      check(device->CreateTexture2D(&desc, nullptr, nv12Scratch_.GetAddressOf()), "nv12_scratch_failed");
      check(device->CreateShaderResourceView(nv12Scratch_.Get(), nullptr, nv12ScratchView_.GetAddressOf()), "nv12_scratch_view_failed");
      check(device->CreateRenderTargetView(nv12Scratch_.Get(), nullptr, nv12ScratchTarget_.GetAddressOf()), "nv12_scratch_target_failed");
      const auto luma = compile("nv12LumaMain", "ps_4_0"), chroma = compile("nv12ChromaMain", "ps_4_0");
      check(device->CreatePixelShader(luma->GetBufferPointer(), luma->GetBufferSize(), nullptr,
        luma_.GetAddressOf()), "nv12_luma_shader_failed");
      check(device->CreatePixelShader(chroma->GetBufferPointer(), chroma->GetBufferSize(), nullptr,
        chroma_.GetAddressOf()), "nv12_chroma_shader_failed");
    }
    D3D11_BUFFER_DESC buffer{}; buffer.ByteWidth = sizeof(Constants); buffer.Usage = D3D11_USAGE_DEFAULT;
    buffer.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    check(device->CreateBuffer(&buffer, nullptr, constants_.GetAddressOf()), "constant_buffer_failed");
    D3D11_RASTERIZER_DESC raster{}; raster.FillMode = D3D11_FILL_SOLID; raster.CullMode = D3D11_CULL_NONE;
    raster.DepthClipEnable = TRUE;
    check(device->CreateRasterizerState(&raster, rasterizer_.GetAddressOf()), "rasterizer_failed");
    D3D11_DEPTH_STENCIL_DESC depth{}; depth.DepthFunc = D3D11_COMPARISON_ALWAYS;
    check(device->CreateDepthStencilState(&depth, depth_.GetAddressOf()), "depth_state_failed");
    // Bound even while invisible, so no driver samples an unbound UINT texture.
    CursorShape empty; empty.width = empty.height = 1; empty.type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
    empty.bytes.assign(4, 0); uploadCursor(device, empty);
  }
  ~Pipeline() { if (!cursorBytes_.empty()) SecureZeroMemory(cursorBytes_.data(), cursorBytes_.size()); }
  bool uploadCursor(ID3D11Device* device, const CursorShape& cursor) {
    if (values.cursorWidth == cursor.width && values.cursorHeight == cursor.height &&
        values.cursorType == cursor.type && cursorBytes_ == cursor.bytes) return false;
    cursorView_.Reset(); cursorTexture_.Reset();
    const auto desc = textureDesc(cursor.width, cursor.height, DXGI_FORMAT_R8G8B8A8_UINT, D3D11_BIND_SHADER_RESOURCE);
    const D3D11_SUBRESOURCE_DATA data{cursor.bytes.data(), cursor.width * 4, 0};
    check(device->CreateTexture2D(&desc, &data, cursorTexture_.GetAddressOf()), "cursor_texture_failed");
    check(device->CreateShaderResourceView(cursorTexture_.Get(), nullptr, cursorView_.GetAddressOf()), "cursor_view_failed");
    values.cursorWidth = cursor.width; values.cursorHeight = cursor.height; values.cursorType = cursor.type;
    if (!cursorBytes_.empty()) SecureZeroMemory(cursorBytes_.data(), cursorBytes_.size());
    cursorBytes_ = cursor.bytes;
    return true;
  }
  void draw(ID3D11DeviceContext* context, ID3D11RenderTargetView* destination) {
    context->UpdateSubresource(constants_.Get(), 0, nullptr, &values, 0, 0);
    ID3D11Buffer* constants = constants_.Get(); context->PSSetConstantBuffers(0, 1, &constants);
    context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertex_.Get(), nullptr, 0);
    context->RSSetState(rasterizer_.Get()); context->OMSetDepthStencilState(depth_.Get(), 0);
    context->OMSetBlendState(nullptr, nullptr, 0xFFFFFFFF);
    ID3D11ShaderResourceView* views[]{sourceView_.Get(), cursorView_.Get()};
    ID3D11RenderTargetView* target = intermediateTarget_.Get();
    D3D11_VIEWPORT viewport{0, 0, FLOAT(values.targetWidth), FLOAT(values.sourceHeight), 0, 1};
    context->RSSetViewports(1, &viewport); context->OMSetRenderTargets(1, &target, nullptr);
    context->PSSetShaderResources(0, 2, views); context->PSSetShader(horizontal_.Get(), nullptr, 0);
    context->Draw(3, 0);
    ID3D11ShaderResourceView* none[]{nullptr, nullptr}; context->PSSetShaderResources(0, 2, none);
    context->OMSetRenderTargets(0, nullptr, nullptr);
    views[0] = intermediateView_.Get(); views[1] = nullptr;
    viewport.Height = FLOAT(values.targetHeight); context->RSSetViewports(1, &viewport);
    context->OMSetRenderTargets(1, &destination, nullptr); context->PSSetShaderResources(0, 2, views);
    context->PSSetShader(vertical_.Get(), nullptr, 0); context->Draw(3, 0);
    context->PSSetShaderResources(0, 2, none); context->OMSetRenderTargets(0, nullptr, nullptr);
  }
  // Exposed only to the synthetic validation executable; production never maps
  // or exports this local texture. One scratch is safe because gpuComplete
  // finishes every draw before any subsequent frame or scratch reuse.
  ID3D11Texture2D* nv12Scratch() const { return nv12Scratch_.Get(); }
  void drawNv12(ID3D11DeviceContext* context, ID3D11RenderTargetView* yTarget,
      ID3D11RenderTargetView* uvTarget) {
    require(nv12Scratch_ && luma_ && chroma_ && yTarget && uvTarget, "nv12_pipeline_unavailable");
    draw(context, nv12ScratchTarget_.Get());
    ID3D11ShaderResourceView* view = nv12ScratchView_.Get(); context->PSSetShaderResources(0, 1, &view);
    D3D11_VIEWPORT viewport{0, 0, FLOAT(values.targetWidth), FLOAT(values.targetHeight), 0, 1};
    context->RSSetViewports(1, &viewport); context->OMSetRenderTargets(1, &yTarget, nullptr);
    context->PSSetShader(luma_.Get(), nullptr, 0); context->Draw(3, 0);
    context->OMSetRenderTargets(0, nullptr, nullptr);
    viewport.Width /= 2; viewport.Height /= 2;
    context->RSSetViewports(1, &viewport); context->OMSetRenderTargets(1, &uvTarget, nullptr);
    context->PSSetShader(chroma_.Get(), nullptr, 0); context->Draw(3, 0);
    view = nullptr; context->PSSetShaderResources(0, 1, &view); context->OMSetRenderTargets(0, nullptr, nullptr);
  }
};
template<class Duplication> class AcquiredFrame {
  Duplication* duplication_;
  bool held_ = false;
public:
  explicit AcquiredFrame(Duplication* duplication) : duplication_(duplication) {}
  AcquiredFrame(const AcquiredFrame&) = delete;
  AcquiredFrame& operator=(const AcquiredFrame&) = delete;
  void hold() { require(!held_, "invalid_frame_hold"); held_ = true; }
  void release() {
    if (!held_) return;
    held_ = false; check(duplication_->ReleaseFrame(), "frame_release_failed");
  }
  ~AcquiredFrame() { if (held_) duplication_->ReleaseFrame(); }
};
static bool gpuComplete(ID3D11DeviceContext* context, ID3D11Query* query, HANDLE owner,
    Timer& timer, Input& input, std::array<Slot, 3>& slots, const Clock& clock, CaptureTiming& timing,
    uint64_t deadline = 0) {
  Measure waitTiming(timing, CaptureTiming::GpuWait, clock);
  { Measure flushTiming(timing, CaptureTiming::GpuFlush, clock); context->End(query); context->Flush(); }
  if (!deadline) deadline = clock.us() + 500000;
  while (true) {
    HRESULT result;
    { Measure queryTiming(timing, CaptureTiming::GpuQuery, clock);
      result = context->GetData(query, nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH); }
    if (result == S_OK) return true;
    require(result == S_FALSE, "gpu_completion_failed");
    require(clock.us() < deadline, "gpu_completion_timeout");
    if (!input.pump(owner, slots)) return false;
    timer.wait(owner, 1000, &timing, &clock);
  }
}
static bool fenceReached(uint64_t completed, uint64_t target) {
  // D3D11Fence documents GetCompletedValue as equivalent to D3D12Fence, whose
  // UINT64_MAX return denotes device removal. Never mistake it for completion.
  require(completed != std::numeric_limits<uint64_t>::max(), "gpu_device_lost");
  return completed >= target;
}
// CPU-testable wait policy; the event is only a wake-up hint. Slot ownership and
// output remain behind the completed-value barrier, including spurious wakes.
template<class Pump, class Probe, class Arm, class Wait, class Now>
static bool waitForFence(uint64_t target, Pump&& pump, Probe&& probe, Arm&& arm, Wait&& wait, Now&& now,
    uint64_t deadline = 0) {
  if (!deadline) deadline = now() + 500000;
  bool armed = false;
  while (true) {
    // Stop and owner/pipe failure take priority even if the GPU is already done.
    if (!pump()) return false;
    if (fenceReached(probe(), target)) return true;
    require(now() < deadline, "gpu_completion_timeout");
    if (!armed) { arm(); armed = true; }
    const uint64_t current = now();
    require(current < deadline, "gpu_completion_timeout");
    wait(std::min<uint64_t>(1000, deadline - current));
  }
}
class GpuCompletion {
  ID3D11Device* device_;
  ID3D11DeviceContext* context_;
  CompletionMode mode_;
  ComPtr<ID3D11Query> query_;
  // Release COM references before closing the event; no OS wait is outstanding
  // when this scope unwinds on stop, owner exit, timeout or a D3D failure.
  Handle event_;
  ComPtr<ID3D11Fence> fence_;
  ComPtr<ID3D11DeviceContext4> context4_;
  uint64_t value_ = 0, deadline_ = 0;
  void checked(HRESULT result, const char* code) {
    if (FAILED(result)) check(device_->GetDeviceRemovedReason(), "gpu_device_lost");
    check(result, code);
  }
public:
  GpuCompletion(ID3D11Device* device, ID3D11DeviceContext* context, CompletionMode mode)
      : device_(device), context_(context), mode_(mode) {
    if (mode_ == CompletionMode::Query) {
      const D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
      check(device->CreateQuery(&query, query_.GetAddressOf()), "completion_query_failed");
      return;
    }
    // An explicit experiment must fail visibly on unsupported interfaces or
    // creation failure; it must never silently run the query baseline instead.
    ComPtr<ID3D11Device5> device5;
    check(device->QueryInterface(IID_PPV_ARGS(device5.GetAddressOf())), "completion_fence_unsupported");
    check(context->QueryInterface(IID_PPV_ARGS(context4_.GetAddressOf())), "completion_fence_unsupported");
    checked(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE, IID_PPV_ARGS(fence_.GetAddressOf())),
      "completion_fence_failed");
    event_.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    require(event_.value != nullptr, "completion_event_failed");
  }
  bool complete(HANDLE owner, Timer& timer, Input& input, std::array<Slot, 3>& slots,
      const Clock& clock, CaptureTiming& timing) {
    const uint64_t begin = clock.us();
    require(begin <= std::numeric_limits<uint64_t>::max() - 500000, "gpu_completion_timeout");
    // One absolute host deadline includes submission, GPU completion and any
    // subsequent CPU staging Map readiness. Mapping never starts a new budget.
    deadline_ = begin + 500000;
    if (mode_ == CompletionMode::Query)
      return gpuComplete(context_, query_.Get(), owner, timer, input, slots, clock, timing, deadline_);
    Measure waitTiming(timing, CaptureTiming::GpuWait, clock);
    // Signal is ordered after the draw and optional staging copy on this
    // immediate context. Flush submits it; Flush itself is never the barrier.
    require(value_ < std::numeric_limits<uint64_t>::max() - 1, "completion_fence_exhausted");
    const uint64_t target = ++value_;
    { Measure flushTiming(timing, CaptureTiming::GpuFlush, clock);
      checked(context4_->Signal(fence_.Get(), target), "completion_fence_signal_failed");
      context_->Flush(); }
    // These are host wall-time stages, not GPU execution timestamps. TimerWait
    // may overlap gpuEventWait, as query-mode timer waits overlap gpuWait.
    return waitForFence(target,
      [&] { return input.pump(owner, slots); },
      [&] { Measure checkTiming(timing, CaptureTiming::GpuFenceCheck, clock); return fence_->GetCompletedValue(); },
      [&] { Measure armTiming(timing, CaptureTiming::GpuEventArm, clock);
        // Auto-reset consumes each wake; reset also removes a late signal from
        // a prior already-completed target before registering this target.
        require(ResetEvent(event_.value), "completion_event_failed");
        checked(fence_->SetEventOnCompletion(target, event_.value), "completion_fence_event_failed"); },
      [&](uint64_t us) { Measure eventTiming(timing, CaptureTiming::GpuEventWait, clock);
        timer.wait(owner, us, &timing, &clock, event_.value); },
      [&] { return clock.us(); }, deadline_);
  }
  uint64_t deadline() const { require(deadline_ != 0, "gpu_completion_not_started"); return deadline_; }
};
struct CpuMapProgress {
  uint64_t attempts = 0, stillDrawing = 0, elapsedUs = 0;
  HRESULT lastResult = S_OK;
  bool cancelled = false, timedOut = false;
};
// A completed GPU timeline is not a promise that this driver's CPU staging Map
// is immediately ready. Only a successful nonblocking Map opens this barrier.
// Callbacks keep the exact production retry/cancel/deadline policy CPU-testable.
template<class Map, class Pump, class Wait, class Now>
static bool waitForCpuMap(uint64_t deadline, CpuMapProgress& progress,
    Map&& map, Pump&& pump, Wait&& wait, Now&& now) {
  const uint64_t begin = now();
  bool ready = false;
  try {
    while (true) {
      if (!pump()) { progress.cancelled = true; break; }
      const uint64_t current = now();
      if (current >= deadline) { progress.timedOut = true; throw Failure("cpu_staging_map_timeout"); }
      ++progress.attempts; progress.lastResult = map();
      if (progress.lastResult == S_OK) { ready = true; break; }
      require(progress.lastResult != DXGI_ERROR_DEVICE_REMOVED, "gpu_device_lost");
      require(progress.lastResult == DXGI_ERROR_WAS_STILL_DRAWING, "cpu_staging_map_failed");
      ++progress.stillDrawing;
      // Pump again before yielding so a stop queued during Map wins promptly.
      if (!pump()) { progress.cancelled = true; break; }
      const uint64_t afterMap = now();
      if (afterMap >= deadline) { progress.timedOut = true; throw Failure("cpu_staging_map_timeout"); }
      wait(std::min<uint64_t>(250, deadline - afterMap));
    }
  } catch (...) { progress.elapsedUs = now() - begin; throw; }
  progress.elapsedUs = now() - begin;
  return ready;
}
static bool mapCpuReadback(ID3D11DeviceContext* context, ID3D11Texture2D* texture,
    uint64_t deadline, HANDLE owner, Timer& timer, Input& input, std::array<Slot, 3>& slots,
    const Clock& clock, CaptureTiming& timing, D3D11_MAPPED_SUBRESOURCE& mapped,
    CpuMapProgress* result = nullptr) {
  CpuMapProgress local; auto& progress = result ? *result : local; progress = {};
  // Publish only bounded counters and host wall time. cpuMapWait covers Map and
  // its readiness waits; cpuReadback separately covers the row copy and Unmap.
  struct Accounting {
    CaptureTiming& timing;
    CpuMapProgress& progress;
    ~Accounting() {
      if (!timing.enabled) return;
      timing.stages[CaptureTiming::CpuMapWait].add(progress.elapsedUs);
      timing.cpuMapAttempts += progress.attempts; timing.cpuMapStillDrawing += progress.stillDrawing;
      timing.cpuMapCancelled += progress.cancelled ? 1 : 0; timing.cpuMapTimeouts += progress.timedOut ? 1 : 0;
    }
  } accounting{timing, progress};
  mapped = {};
  try {
    return waitForCpuMap(deadline, progress,
      [&] {
        mapped = {};
        const HRESULT hr = context->Map(texture, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
        if (hr != S_OK) mapped = {};
        return hr;
      },
      [&] { return input.pump(owner, slots); },
      [&](uint64_t us) { timer.wait(owner, us, &timing, &clock); },
      [&] { return clock.us(); });
  } catch (const Failure& failure) {
    // A fatal Map or exhausted readiness budget must not mask device removal.
    // Owner/pipe/stop failures retain their original priority and fixed code.
    if (std::strcmp(failure.what(), "cpu_staging_map_failed") == 0 ||
        std::strcmp(failure.what(), "cpu_staging_map_timeout") == 0) {
      ComPtr<ID3D11Device> device; context->GetDevice(device.GetAddressOf());
      check(device->GetDeviceRemovedReason(), "gpu_device_lost");
    }
    throw;
  }
}
static void createSlot(ID3D11Device* device, Slot& slot, Size size, bool nv12 = false, bool cpu = false) {
  require(!cpu || nv12, "invalid_cpu_frame_layout");
  const size_t cpuBytes = cpu ? tightNv12ByteLength(size) : 0;
  require(!nv12 || (size.width % 2 == 0 && size.height % 2 == 0), "invalid_nv12_dimensions");
  auto desc = textureDesc(size.width, size.height, nv12 ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM,
    D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE);
  desc.MiscFlags = cpu ? 0 : D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  check(device->CreateTexture2D(&desc, nullptr, slot.texture.GetAddressOf()), nv12 ? "nv12_shared_texture_failed" : "shared_texture_failed");
  if (nv12) {
    ComPtr<ID3D11Device3> device3; check(device->QueryInterface(IID_PPV_ARGS(device3.GetAddressOf())), "nv12_device3_unsupported");
    D3D11_RENDER_TARGET_VIEW_DESC1 view{}; view.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
    view.Format = DXGI_FORMAT_R8_UNORM; view.Texture2D.MipSlice = 0; view.Texture2D.PlaneSlice = 0;
    ComPtr<ID3D11RenderTargetView1> yTarget, uvTarget;
    check(device3->CreateRenderTargetView1(slot.texture.Get(), &view, yTarget.GetAddressOf()), "nv12_luma_target_failed");
    view.Format = DXGI_FORMAT_R8G8_UNORM; view.Texture2D.PlaneSlice = 1;
    check(device3->CreateRenderTargetView1(slot.texture.Get(), &view, uvTarget.GetAddressOf()), "nv12_chroma_target_failed");
    slot.target = yTarget; slot.chromaTarget = uvTarget;
  } else {
    check(device->CreateRenderTargetView(slot.texture.Get(), nullptr, slot.target.GetAddressOf()), "shared_target_failed");
  }
  if (cpu) {
    auto staging = desc; staging.Usage = D3D11_USAGE_STAGING; staging.BindFlags = 0;
    staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ; staging.MiscFlags = 0;
    check(device->CreateTexture2D(&staging, nullptr, slot.staging.GetAddressOf()), "cpu_staging_texture_failed");
    // Null attributes mean a non-inheritable handle with the process's default
    // security descriptor. This unnamed pagefile section changes no ACL policy.
    slot.local.value = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, DWORD(cpuBytes), nullptr);
    require(slot.local.value != nullptr, "cpu_shared_memory_failed");
    slot.cpuView.open(slot.local.value, cpuBytes);
    return;
  }
  check(slot.texture.As(&slot.mutex), "shared_mutex_failed");
  ComPtr<IDXGIResource1> resource; check(slot.texture.As(&resource), "shared_resource_failed");
  check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
    nullptr, &slot.local.value), "shared_handle_failed");
}

static void capture(const Options& option) {
  require(sizeof(void*) == 8, "unsupported_architecture");
  require(option.owner == parentPid(), "owner_is_not_parent");
  // These are the only rights requested for the actual parent process.
  Handle owner(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, option.owner));
  require(owner.value && ownerAlive(owner.value), "owner_unavailable");
  require(SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) ||
    AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
    "dpi_context_unavailable");
  Clock clock; CaptureTiming timing; timing.selectedCompletion = option.completion;
  StartupTiming startup(clock, timing.enabled, option.completion);
  Timer timer; Input input;
  startup.next(StartupTiming::SourceLookup);
  auto output = primaryOutput();
  const Size source{UINT(output.desc.DesktopCoordinates.right), UINT(output.desc.DesktopCoordinates.bottom)};
  const auto size = scaledSize(source.width, source.height, option.maxWidth, option.maxHeight);
  if (option.cpu) tightNv12ByteLength(size);
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_0};
  startup.next(StartupTiming::Device);
  check(D3D11CreateDevice(output.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 1, D3D11_SDK_VERSION,
    device.GetAddressOf(), nullptr, context.GetAddressOf()), "hardware_device_failed");
  startup.next(StartupTiming::Pipeline);
  Pipeline pipeline(device.Get(), source, size, option.nv12);
  startup.next(StartupTiming::Slots);
  std::array<Slot, 3> slots;
  for (auto& slot : slots) createSlot(device.Get(), slot, size, option.nv12, option.cpu);
  startup.next(StartupTiming::Query);
  GpuCompletion completion(device.Get(), context.Get(), option.completion);
  startup.next(StartupTiming::ValidateOutput);
  validateOutput(output);
  startup.next(StartupTiming::DuplicateOutput);
  ComPtr<IDXGIOutputDuplication> duplication;
  check(output.output->DuplicateOutput(device.Get(), duplication.GetAddressOf()), "duplication_failed");
  DXGI_OUTDUPL_DESC duplicationDesc{}; duplication->GetDesc(&duplicationDesc);
  require(duplicationDesc.ModeDesc.Width == source.width && duplicationDesc.ModeDesc.Height == source.height &&
    duplicationDesc.ModeDesc.Format == DXGI_FORMAT_B8G8R8A8_UNORM &&
    duplicationDesc.Rotation == DXGI_MODE_ROTATION_IDENTITY, "unsupported_duplication_geometry");
  // Retain DXGI ownership until this input's submitted read is finished. GPU
  // sharing releases after the completion barrier and mutex unlock; CPU output
  // releases after staging readback. Downstream slot credits never retain DDA.
  // This guard dies before duplication/device and releases on every exit path.
  AcquiredFrame acquired(duplication.Get());
  // Handles in either protocol belong to this helper's table. The main-process native
  // bridge duplicates them synchronously and uniquely closes its local copy.
  // This process never creates an unowned handle in its parent's handle table.
  startup.next(StartupTiming::ReadyOutput);
  std::cout << "{\"type\":\"ready\",\"protocol\":" << (option.cpu ? 4 : option.nv12 ? 3 : 2);
  if (option.cpu) std::cout << ",\"storage\":\"cpu\"";
  if (option.nv12) std::cout << ",\"pixelFormat\":\"nv12\",\"colorSpace\":\"bt709-limited\"";
  std::cout << ",\"width\":" << size.width << ",\"height\":" << size.height
    << ",\"sourceWidth\":" << source.width << ",\"sourceHeight\":" << source.height
    << ",\"poolSize\":3,\"cursorSupported\":true}" << std::endl;
  require(bool(std::cout), "owner_output_closed");
  startup.report(true);
  uint64_t serial = 0, lastTimestamp = 0, nextTick = clock.us(), lastSent = 0, nextDisplayCheck = 0;
  uint64_t newFrames = 0, refreshFrames = 0, backpressureTicks = 0;
  LONGLONG lastPresent = 0, lastMouse = 0;
  bool haveDesktop = false, haveShape = false, dirty = false;
  const uint64_t period = 1000000 / option.fps;
  timing.start(nextTick, period);
  bool running = true;
  while (running) {
    if (!input.pump(owner.value, slots)) break;
    uint64_t now = clock.us();
    timing.report(now);
    for (const auto& slot : slots) require(!slot.lease.busy || now - slot.sentAt < 10000000,
      "slot_release_timeout");
    if (now < nextTick) { timer.wait(owner.value, nextTick - now, &timing, &clock); continue; }
    Measure tickTiming(timing, CaptureTiming::TickWork, clock);
    if (timing.enabled) {
      ++timing.ticks; timing.missedTicks += (now - nextTick) / period;
      timing.stages[CaptureTiming::TickLateness].add(now - nextTick);
    }
    // One latest update per due tick; skip missed ticks and preserve the original
    // phase. Readiness retries share this tick's strictly future phase deadline.
    nextTick = advanceTick(nextTick, now, period);
    if (now >= nextDisplayCheck) {
      validateOutput(output); check(device->GetDeviceRemovedReason(), "gpu_device_lost");
      nextDisplayCheck = now + 250000;
    } else validateOutputFast(output);
    auto available = slots.end();
    ReadinessWindow window(nextTick);
    bool frameReady = false, refresh = false, lastUnavailableSlot = false;
    while (window.open(clock.us())) {
      if (!input.pump(owner.value, slots)) { window.cancel(); running = false; break; }
      now = clock.us();
      if (!window.open(now)) break;
      available = std::find_if(slots.begin(), slots.end(), [](const Slot& slot) { return !slot.lease.busy; });
      lastUnavailableSlot = available == slots.end();
      if (lastUnavailableSlot) {
        if (!window.waitedSlot) {
          window.waitedSlot = true;
          if (timing.enabled) ++timing.readinessSlotWaitWindows;
        }
        if (timing.enabled && !timing.creditWaitBegin) timing.creditWaitBegin = now;
        const uint64_t wait = window.waitUs(clock.us(), 500);
        if (wait) timer.wait(owner.value, wait, &timing, &clock);
        continue;
      }
      if (timing.enabled && timing.creditWaitBegin) {
        timing.stages[CaptureTiming::SlotCreditWait].add(now - timing.creditWaitBegin); timing.creditWaitBegin = 0;
      }
      DXGI_OUTDUPL_FRAME_INFO info{}; ComPtr<IDXGIResource> resource;
      HRESULT result;
      { Measure releaseTiming(timing, CaptureTiming::FrameRelease, clock); acquired.release(); }
      now = clock.us();
      if (!window.open(now)) break;
      const UINT acquireTimeout = window.acquireTimeoutMs(now);
      if (++window.attempts > 1 && timing.enabled) ++timing.readinessRetries;
      { Measure acquireTiming(timing, CaptureTiming::Acquire, clock);
        result = duplication->AcquireNextFrame(acquireTimeout, &info, resource.GetAddressOf()); }
      if (timing.enabled && result == DXGI_ERROR_WAIT_TIMEOUT) ++timing.acquireTimeout;
      if (result != DXGI_ERROR_WAIT_TIMEOUT) {
        check(result, "desktop_acquire_failed"); acquired.hold();
        if (timing.enabled) {
          ++timing.acquireSuccess;
          timing.accumulatedFrames += info.AccumulatedFrames;
          timing.maxAccumulatedFrames = std::max(timing.maxAccumulatedFrames, uint64_t(info.AccumulatedFrames));
          if (!info.LastPresentTime.QuadPart) ++timing.pointerOnly;
        }
        if (info.LastPresentTime.QuadPart > lastPresent || !haveDesktop) {
          if (timing.enabled) ++timing.sourcePresents;
          ComPtr<ID3D11Texture2D> texture; check(resource.As(&texture), "desktop_texture_query_failed");
          D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
          require(desc.Width == source.width && desc.Height == source.height &&
            desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM && desc.SampleDesc.Count == 1,
            "desktop_geometry_changed");
          context->CopyResource(pipeline.desktop.Get(), texture.Get());
          haveDesktop = true; dirty = true; lastPresent = info.LastPresentTime.QuadPart;
        }
        if (info.LastMouseUpdateTime.QuadPart > lastMouse) {
          const auto& pointer = info.PointerPosition;
          const bool changed = bool(pointer.Visible) != bool(pipeline.values.cursorVisible) ||
            (pointer.Visible && (pointer.Position.x != pipeline.values.cursorX || pointer.Position.y != pipeline.values.cursorY));
          pipeline.values.cursorVisible = pointer.Visible ? 1 : 0;
          if (pointer.Visible) {
            // DXGI Position is already the top-left in output pixels. Do not
            // subtract HotSpot (Microsoft DXGI_OUTDUPL_POINTER_SHAPE_INFO).
            require(pointer.Position.x >= -INT(kMaxCursorDimension) && pointer.Position.y >= -INT(kMaxCursorDimension) &&
              pointer.Position.x <= INT(source.width) && pointer.Position.y <= INT(source.height), "invalid_cursor_position");
            pipeline.values.cursorX = pointer.Position.x; pipeline.values.cursorY = pointer.Position.y;
          }
          dirty = dirty || changed; lastMouse = info.LastMouseUpdateTime.QuadPart;
        }
        if (info.PointerShapeBufferSize) {
          require(info.PointerShapeBufferSize <= kMaxCursorBytes, "unsupported_cursor_shape");
          std::vector<unsigned char> raw(info.PointerShapeBufferSize);
          DXGI_OUTDUPL_POINTER_SHAPE_INFO shapeInfo{}; UINT needed = 0;
          const HRESULT shapeResult = duplication->GetFramePointerShape(UINT(raw.size()), raw.data(), &needed, &shapeInfo);
          if (FAILED(shapeResult) || needed > raw.size()) {
            SecureZeroMemory(raw.data(), raw.size()); throw Failure("cursor_shape_query_failed");
          }
          try {
            const auto shape = decodeCursor(shapeInfo, raw.data(), needed);
            const bool changed = pipeline.uploadCursor(device.Get(), shape); haveShape = true;
            dirty = dirty || (changed && pipeline.values.cursorVisible);
          } catch (...) { SecureZeroMemory(raw.data(), raw.size()); throw; }
          SecureZeroMemory(raw.data(), raw.size());
        }
        require(!pipeline.values.cursorVisible || haveShape, "visible_cursor_shape_unavailable");
      }
      now = clock.us();
      refresh = !dirty && haveDesktop && now - lastSent >= 250000;
      if (haveDesktop && (dirty || refresh)) { frameReady = true; window.complete(); break; }
      if (!window.waitedPresent) {
        window.waitedPresent = true;
        if (timing.enabled) ++timing.readinessPresentWaitWindows;
      }
      // A zero-timeout tail still yields; repeated unsuccessful nonblocking
      // Acquire calls must not turn the remaining budget into a busy loop.
      if (!acquireTimeout) {
        const uint64_t wait = window.waitUs(clock.us(), 250);
        if (wait) timer.wait(owner.value, wait, &timing, &clock);
      }
    }
    if (!running) { if (timing.enabled) ++timing.readinessCancelled; break; }
    if (!frameReady) {
      // An expired readiness attempt has submitted no desktop read. Neither
      // output mode pins a duplication input across downstream credit waits.
      { Measure releaseTiming(timing, CaptureTiming::FrameRelease, clock); acquired.release(); }
      if (lastUnavailableSlot) ++backpressureTicks;
      if (timing.enabled) {
        ++timing.readinessExpired;
        if (lastUnavailableSlot) ++timing.noSlot; else ++timing.noPresent;
      }
      continue;
    }
    if (timing.enabled) {
      if (window.waitedSlot) ++timing.readinessRecoveredSlot;
      if (window.waitedPresent) ++timing.readinessRecoveredPresent;
    }
    auto& slot = *available;
    // Key 0 matches Electron's DXGI shared texture import. Credits, rather than
    // mutex availability alone, govern reuse while encoder references exist.
    bool locked = false;
    if (!option.cpu) { require(slot.mutex->AcquireSync(0, 0) == S_OK, "shared_mutex_unavailable"); locked = true; }
    try {
      { Measure drawTiming(timing, CaptureTiming::Draw, clock);
        if (option.nv12) pipeline.drawNv12(context.Get(), slot.target.Get(), slot.chromaTarget.Get());
        else pipeline.draw(context.Get(), slot.target.Get()); }
      if (option.cpu) context->CopyResource(slot.staging.Get(), slot.texture.Get());
      running = completion.complete(owner.value, timer, input, slots, clock, timing);
      if (locked) { check(slot.mutex->ReleaseSync(0), "shared_mutex_release_failed"); locked = false; }
    } catch (...) { if (locked) slot.mutex->ReleaseSync(0); throw; }
    // Restore the GPU-sharing ownership boundary: renderer references/credits
    // may outlive this completed GPU read, so they must not retain its DDA input.
    if (!option.cpu) { Measure releaseTiming(timing, CaptureTiming::FrameRelease, clock); acquired.release(); }
    if (!running) break;
    if (option.cpu) {
      D3D11_MAPPED_SUBRESOURCE mapped{};
      try {
        running = mapCpuReadback(context.Get(), slot.staging.Get(), completion.deadline(),
          owner.value, timer, input, slots, clock, timing, mapped);
      } catch (...) {
        // Preserve the fixed failure while making the final attempt/timeout
        // counters visible even when this frame never reaches normal teardown.
        try { timing.report(clock.us(), true); } catch (...) {}
        throw;
      }
      if (!running) break;
      {
        Measure copyTiming(timing, CaptureTiming::CpuReadback, clock);
        try { copyNv12Rows(mapped, size, slot.cpuView.value, slot.cpuView.byteLength); }
        catch (...) { context->Unmap(slot.staging.Get(), 0); throw; }
        context->Unmap(slot.staging.Get(), 0);
      }
      // The GPU and CPU copies are complete. Release DDA input before exporting
      // the section; its reuse depends only on the original per-slot ACKs.
      { Measure releaseTiming(timing, CaptureTiming::FrameRelease, clock); acquired.release(); }
    }
    check(device->GetDeviceRemovedReason(), "gpu_device_lost");
    validateOutputFast(output);
    require(serial < kSafeInteger, "serial_exhausted");
    slot.lease.issue(++serial); slot.sentAt = clock.us();
    const uint64_t timestamp = std::max(lastTimestamp + 1, slot.sentAt);
    require(timestamp <= kSafeInteger, "timestamp_exhausted"); lastTimestamp = timestamp;
    const auto index = size_t(std::distance(slots.begin(), available));
    { Measure outputTiming(timing, CaptureTiming::Output, clock);
      std::cout << "{\"type\":\"frame\",\"slot\":" << index << ",\"serial\":" << serial << ",\"handle\":\"0x"
      << std::hex << uintptr_t(slot.local.value) << std::dec << "\",\"timestamp\":" << timestamp
      << ",\"width\":" << size.width << ",\"height\":" << size.height;
      if (option.nv12) std::cout << ",\"pixelFormat\":\"nv12\"";
      if (option.cpu) std::cout << ",\"storage\":\"cpu\",\"byteLength\":" << slot.cpuView.byteLength;
      std::cout << ",\"refresh\":" << (refresh ? "true" : "false") << "}" << std::endl; }
    require(bool(std::cout), "owner_output_closed");
    if (refresh) ++refreshFrames; else ++newFrames;
    if (timing.enabled) { if (refresh) ++timing.refreshFrames; else ++timing.newFrames; }
    dirty = false; lastSent = slot.sentAt;
  }
  { Measure releaseTiming(timing, CaptureTiming::FrameRelease, clock); acquired.release(); }
  timing.report(clock.us(), true);
  std::cout << "{\"type\":\"done\",\"frames\":" << serial << ",\"newFrames\":" << newFrames
    << ",\"refreshFrames\":" << refreshFrames << ",\"backpressureTicks\":" << backpressureTicks << "}" << std::endl;
}

// CPU-only reference functions exercise the pixel/geometry and ownership rules.
// They never create a D3D device, query a monitor or acquire the desktop.
using Pixel = std::array<double, 4>; // BGRA, 0..255
static Pixel cursorReference(Pixel base, const CursorShape& shape, int x, int y) {
  if (x < 0 || y < 0 || x >= int(shape.width) || y >= int(shape.height)) return base;
  const auto* cursor = shape.bytes.data() + (size_t(y) * shape.width + size_t(x)) * 4;
  for (unsigned channel = 0; channel < 3; ++channel) {
    if (shape.type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME)
      base[channel] = (unsigned(std::lround(base[channel])) & cursor[0]) ^ cursor[1];
    else if (shape.type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR)
      base[channel] = cursor[3] ? unsigned(std::lround(base[channel])) ^ cursor[channel] : cursor[channel];
    else base[channel] = cursor[channel] * (cursor[3] / 255.0) + base[channel] * (1 - cursor[3] / 255.0);
  }
  return base;
}
static std::vector<Pixel> areaReference(const std::vector<Pixel>& source, Size size, Size target) {
  std::vector<Pixel> result(size_t(target.width) * target.height);
  for (UINT y = 0; y < target.height; ++y) for (UINT x = 0; x < target.width; ++x) {
    const double left = double(x) * size.width / target.width, right = double(x + 1) * size.width / target.width;
    const double top = double(y) * size.height / target.height, bottom = double(y + 1) * size.height / target.height;
    auto& pixel = result[size_t(y) * target.width + x];
    for (UINT sy = UINT(std::floor(top)); sy < UINT(std::ceil(bottom)); ++sy)
      for (UINT sx = UINT(std::floor(left)); sx < UINT(std::ceil(right)); ++sx) {
        const double weight = std::max(0.0, std::min(right, double(sx + 1)) - std::max(left, double(sx))) *
          std::max(0.0, std::min(bottom, double(sy + 1)) - std::max(top, double(sy))) / ((right - left) * (bottom - top));
        for (unsigned c = 0; c < 4; ++c) pixel[c] += source[size_t(sy) * size.width + sx][c] * weight;
      }
  }
  return result;
}
template<class F> static void rejects(F&& action) {
  bool rejected = false; try { action(); } catch (const Failure&) { rejected = true; }
  require(rejected, "self_test_expected_rejection");
}
static void selfTest() {
  unsigned checks = 0;
  auto expect = [&](bool value) { require(value, "self_test_failed"); ++checks; };
  const auto parseTestOptions = [](std::vector<std::string> arguments) {
    std::vector<char*> argv;
    for (auto& argument : arguments) argv.push_back(argument.data());
    return options(INT(argv.size()), argv.data());
  };
  const std::vector<std::string> bgraArguments{"helper", "--owner-pid", "1", "--max-width", "1920",
    "--max-height", "1080", "--fps", "120"};
  const auto bgraOptions = parseTestOptions(bgraArguments);
  expect(!bgraOptions.nv12 && !bgraOptions.cpu && bgraOptions.maxWidth == 1920 && bgraOptions.maxHeight == 1080 &&
    bgraOptions.fps == 120 && bgraOptions.completion == CompletionMode::Query);
  auto nv12Arguments = bgraArguments; nv12Arguments.insert(nv12Arguments.end(), {"--pixel-format", "nv12"});
  expect(parseTestOptions(nv12Arguments).nv12 && !parseTestOptions(nv12Arguments).cpu);
  auto cpuArguments = nv12Arguments; cpuArguments.insert(cpuArguments.end(), {"--frame-storage", "cpu"});
  expect(parseTestOptions(cpuArguments).nv12 && parseTestOptions(cpuArguments).cpu);
  auto cpuReordered = bgraArguments; cpuReordered.insert(cpuReordered.end(), {"--frame-storage", "cpu", "--pixel-format", "nv12"});
  expect(parseTestOptions(cpuReordered).cpu);
  for (const auto& arguments : {bgraArguments, nv12Arguments, cpuArguments}) {
    for (const auto* mode : {"query", "fence"}) {
      auto explicitMode = arguments; explicitMode.insert(explicitMode.end(), {"--completion", mode});
      const auto parsed = parseTestOptions(explicitMode);
      expect(std::string(completionName(parsed.completion)) == mode &&
        parsed.cpu == (arguments.size() == cpuArguments.size()) && parsed.fps == 120);
    }
  }
  auto invalidCompletion = bgraArguments; invalidCompletion.insert(invalidCompletion.end(), {"--completion", "auto"});
  rejects([&] { parseTestOptions(invalidCompletion); }); ++checks;
  invalidCompletion.back() = "Fence";
  rejects([&] { parseTestOptions(invalidCompletion); }); ++checks;
  invalidCompletion.back() = "fence"; invalidCompletion.insert(invalidCompletion.end(), {"--completion", "query"});
  rejects([&] { parseTestOptions(invalidCompletion); }); ++checks;
  invalidCompletion = bgraArguments; invalidCompletion.push_back("--completion");
  rejects([&] { parseTestOptions(invalidCompletion); }); ++checks;
  invalidCompletion = bgraArguments; invalidCompletion[7] = "--completion"; invalidCompletion[8] = "fence";
  rejects([&] { parseTestOptions(invalidCompletion); }); ++checks;
  const auto expectFailure = [&](auto&& action, const char* code) {
    try { action(); } catch (const Failure& error) { expect(std::string(error.what()) == code); return; }
    throw Failure("self_test_expected_rejection");
  };
  struct TestFenceWait {
    uint64_t completed = 0, time = 0, armAdvance = 0, largestWait = 0;
    unsigned pumps = 0, probes = 0, arms = 0, waits = 0, completeAfterWait = 0, stopAtPump = 0;
    const char* pumpFailure = nullptr;
    bool armFailure = false, waitFailure = false;
    bool run() {
      return waitForFence(7,
        [&] { ++pumps; if (pumpFailure) throw Failure(pumpFailure); return pumps != stopAtPump; },
        [&] { ++probes; return completed; },
        [&] { ++arms; time += armAdvance; if (armFailure) throw Failure("completion_fence_event_failed"); },
        [&](uint64_t us) { ++waits; largestWait = std::max(largestWait, us);
          if (waitFailure) throw Failure("timer_failed");
          time += us; if (waits == completeAfterWait) completed = 7; },
        [&] { return time; });
    }
  };
  TestFenceWait alreadyComplete; alreadyComplete.completed = 7;
  expect(alreadyComplete.run() && alreadyComplete.pumps == 1 && alreadyComplete.probes == 1 &&
    alreadyComplete.arms == 0 && alreadyComplete.waits == 0);
  TestFenceWait stopFirst; stopFirst.completed = 7; stopFirst.stopAtPump = 1;
  expect(!stopFirst.run() && stopFirst.probes == 0 && stopFirst.arms == 0 && stopFirst.waits == 0);
  TestFenceWait pendingFence; pendingFence.completeAfterWait = 2;
  expect(pendingFence.run() && pendingFence.waits == 2 && pendingFence.probes == 3 &&
    pendingFence.pumps == 3 && pendingFence.arms == 1 && pendingFence.largestWait == 1000);
  // First wake had no completed value: it could not release the barrier. A stop
  // arriving with the final completion also wins before that value is probed.
  TestFenceWait stopAfterWake; stopAfterWake.completeAfterWait = 1; stopAfterWake.stopAtPump = 2;
  expect(!stopAfterWake.run() && stopAfterWake.waits == 1 && stopAfterWake.probes == 1);
  TestFenceWait timeoutFence;
  expectFailure([&] { timeoutFence.run(); }, "gpu_completion_timeout");
  expect(timeoutFence.time == 500000 && timeoutFence.waits == 500 && timeoutFence.arms == 1 &&
    timeoutFence.largestWait == 1000);
  TestFenceWait tailFence; tailFence.armAdvance = 499501;
  expectFailure([&] { tailFence.run(); }, "gpu_completion_timeout");
  expect(tailFence.time == 500000 && tailFence.waits == 1 && tailFence.largestWait == 499);
  TestFenceWait lostFence; lostFence.completed = std::numeric_limits<uint64_t>::max();
  expectFailure([&] { lostFence.run(); }, "gpu_device_lost");
  expect(lostFence.arms == 0 && lostFence.waits == 0);
  TestFenceWait deadOwner; deadOwner.completed = 7; deadOwner.pumpFailure = "owner_exited";
  expectFailure([&] { deadOwner.run(); }, "owner_exited");
  expect(deadOwner.probes == 0 && deadOwner.waits == 0);
  TestFenceWait failedArm; failedArm.armFailure = true;
  expectFailure([&] { failedArm.run(); }, "completion_fence_event_failed");
  expect(failedArm.arms == 1 && failedArm.waits == 0);
  TestFenceWait failedWait; failedWait.waitFailure = true;
  expectFailure([&] { failedWait.run(); }, "timer_failed");
  expect(failedWait.arms == 1 && failedWait.waits == 1);
  {
    Timer eventTimer;
    Handle testOwner(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    Handle wakeEvent(CreateEventW(nullptr, FALSE, TRUE, nullptr));
    require(testOwner.value && wakeEvent.value, "self_test_event_failed");
    eventTimer.wait(testOwner.value, 1000, nullptr, nullptr, wakeEvent.value);
    expect(WaitForSingleObject(wakeEvent.value, 0) == WAIT_TIMEOUT); // Auto-reset wake consumed.
    require(SetEvent(testOwner.value) && SetEvent(wakeEvent.value), "self_test_event_failed");
    expectFailure([&] { eventTimer.wait(testOwner.value, 1000, nullptr, nullptr, wakeEvent.value); }, "owner_exited");
    expect(WaitForSingleObject(wakeEvent.value, 0) == WAIT_OBJECT_0); // Owner has first priority.
  }
  struct TestCpuMapWait {
    std::vector<HRESULT> results{S_OK};
    CpuMapProgress progress;
    uint64_t time = 0, deadline = 500000, largestWait = 0;
    unsigned maps = 0, pumps = 0, waits = 0, stopAtPump = 0, ownerExitAtPump = 0;
    const char* waitFailure = nullptr;
    bool run(Lease& output) {
      const bool ready = waitForCpuMap(deadline, progress,
        [&] { const HRESULT hr = results[std::min<size_t>(maps, results.size() - 1)]; ++maps; return hr; },
        [&] { ++pumps; if (pumps == ownerExitAtPump) throw Failure("owner_exited"); return pumps != stopAtPump; },
        [&](uint64_t us) { ++waits; largestWait = std::max(largestWait, us);
          if (waitFailure) throw Failure(waitFailure);
          time += us; },
        [&] { return time; });
      // Model the product boundary: no mapping success means no output lease.
      if (ready) output.issue(1);
      return ready;
    }
  };
  {
    Lease output; TestCpuMapWait map;
    expect(map.run(output) && output.busy && map.maps == 1 && map.waits == 0 &&
      map.progress.attempts == 1 && map.progress.stillDrawing == 0 && !map.progress.cancelled);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING, S_OK};
    expect(map.run(output) && output.busy && map.maps == 2 && map.waits == 1 && map.largestWait == 250 &&
      map.progress.stillDrawing == 1 && map.progress.elapsedUs == 250 && map.progress.lastResult == S_OK);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING, DXGI_ERROR_WAS_STILL_DRAWING, S_OK};
    expect(map.run(output) && output.busy && map.maps == 3 && map.waits == 2 && map.time == 500);
  }
  for (const HRESULT fatal : {E_FAIL, E_OUTOFMEMORY, S_FALSE}) {
    Lease output; TestCpuMapWait map; map.results = {fatal};
    expectFailure([&] { map.run(output); }, "cpu_staging_map_failed");
    expect(!output.busy && map.maps == 1 && map.waits == 0 && map.progress.lastResult == fatal);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING, E_FAIL};
    expectFailure([&] { map.run(output); }, "cpu_staging_map_failed");
    expect(!output.busy && map.maps == 2 && map.waits == 1 && map.progress.stillDrawing == 1);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_DEVICE_REMOVED};
    expectFailure([&] { map.run(output); }, "gpu_device_lost");
    expect(!output.busy && map.maps == 1 && map.waits == 0);
  }
  for (unsigned stopAt : {1U,2U,3U}) {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING, S_OK}; map.stopAtPump = stopAt;
    expect(!map.run(output) && !output.busy && map.progress.cancelled && map.maps <= 1 && map.waits <= 1);
  }
  for (unsigned ownerAt : {1U,3U}) {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING, S_OK}; map.ownerExitAtPump = ownerAt;
    expectFailure([&] { map.run(output); }, "owner_exited");
    expect(!output.busy && map.maps <= 1 && map.waits <= 1);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING}; map.waitFailure = "owner_exited";
    expectFailure([&] { map.run(output); }, "owner_exited");
    expect(!output.busy && map.maps == 1 && map.waits == 1);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING};
    expectFailure([&] { map.run(output); }, "cpu_staging_map_timeout");
    expect(!output.busy && map.progress.timedOut && map.time == 500000 && map.maps == 2000 &&
      map.waits == 2000 && map.largestWait == 250 && map.progress.stillDrawing == 2000);
  }
  {
    Lease output; TestCpuMapWait map; map.results = {DXGI_ERROR_WAS_STILL_DRAWING, S_OK}; map.time = 499901;
    expectFailure([&] { map.run(output); }, "cpu_staging_map_timeout");
    expect(!output.busy && map.maps == 1 && map.waits == 1 && map.largestWait == 99 &&
      map.progress.elapsedUs == 99 && map.time == 500000); // No fresh Map budget after GPU waiting.
  }
  {
    Lease output; TestCpuMapWait map; map.time = map.deadline;
    expectFailure([&] { map.run(output); }, "cpu_staging_map_timeout");
    expect(!output.busy && map.maps == 0 && map.waits == 0 && map.progress.timedOut);
  }
  {
    Lease output; TestCpuMapWait map; map.time = map.deadline; map.stopAtPump = 1;
    expect(!map.run(output) && !output.busy && map.progress.cancelled && map.maps == 0 && !map.progress.timedOut);
  }
  auto invalidStorage = bgraArguments; invalidStorage.insert(invalidStorage.end(), {"--frame-storage", "cpu"});
  rejects([&] { parseTestOptions(invalidStorage); }); ++checks;
  invalidStorage = cpuArguments; invalidStorage.back() = "gpu";
  rejects([&] { parseTestOptions(invalidStorage); }); ++checks;
  invalidStorage.back() = "CPU";
  rejects([&] { parseTestOptions(invalidStorage); }); ++checks;
  invalidStorage = cpuArguments; invalidStorage[9] = "--frame-storage";
  rejects([&] { parseTestOptions(invalidStorage); }); ++checks;
  auto invalidFormat = nv12Arguments; invalidFormat.back() = "bgra";
  rejects([&] { parseTestOptions(invalidFormat); }); ++checks;
  invalidFormat.back() = "NV12";
  rejects([&] { parseTestOptions(invalidFormat); }); ++checks;
  invalidFormat = nv12Arguments; invalidFormat[9] = "--fps";
  rejects([&] { parseTestOptions(invalidFormat); }); ++checks;
  invalidFormat = bgraArguments; invalidFormat.push_back("--pixel-format");
  rejects([&] { parseTestOptions(invalidFormat); }); ++checks;
  expect(tightNv12ByteLength({2,2}) == 6 && tightNv12ByteLength({4,4}) == 24);
  expect(tightNv12ByteLength({1728,1080}) == 2799360 && tightNv12ByteLength({1920,1080}) == 3110400);
  expect(tightNv12ByteLength({3840,2160}) == 12441600 && tightNv12ByteLength({4096,2730}) == 16773120);
  rejects([] { tightNv12ByteLength({4096,2732}); }); ++checks;
  for (Size invalid : {Size{0,2}, Size{2,0}, Size{3,2}, Size{2,3}, Size{16386,2}}) {
    rejects([&] { tightNv12ByteLength(invalid); }); ++checks;
  }
  std::array<unsigned char, 48> padded{}; padded.fill(0xEF);
  std::array<unsigned char, 24> tight{};
  for (unsigned row = 0; row < 6; ++row) for (unsigned column = 0; column < 4; ++column) {
    const auto value = static_cast<unsigned char>(row * 16 + column);
    padded[row * 8 + column] = value; tight[row * 4 + column] = value;
  }
  std::array<unsigned char, 26> destination{}; destination.fill(0xCD);
  D3D11_MAPPED_SUBRESOURCE mapped{}; mapped.pData = padded.data(); mapped.RowPitch = 8;
  copyNv12Rows(mapped, {4,4}, destination.data() + 1, tight.size());
  expect(destination.front() == 0xCD && destination.back() == 0xCD &&
    std::equal(tight.begin(), tight.end(), destination.begin() + 1));
  mapped.pData = tight.data(); mapped.RowPitch = 4;
  copyNv12Rows(mapped, {4,4}, destination.data() + 1, tight.size());
  expect(std::equal(tight.begin(), tight.end(), destination.begin() + 1));
  mapped.RowPitch = 3; rejects([&] { copyNv12Rows(mapped, {4,4}, destination.data() + 1, 24); }); ++checks;
  mapped.RowPitch = 4; rejects([&] { copyNv12Rows(mapped, {4,4}, destination.data() + 1, 23); }); ++checks;
  rejects([&] { copyNv12Rows(mapped, {4,4}, destination.data() + 1, 25); }); ++checks;
  rejects([&] { copyNv12Rows(mapped, {4,4}, nullptr, 24); }); ++checks;
  mapped.pData = nullptr; rejects([&] { copyNv12Rows(mapped, {4,4}, destination.data() + 1, 24); }); ++checks;
  struct TestReadOnlyView {
    const unsigned char* value = nullptr;
    void open(HANDLE section) {
      value = static_cast<const unsigned char*>(MapViewOfFile(section, FILE_MAP_READ, 0, 0, 32));
      require(value != nullptr, "self_test_readonly_view_failed");
    }
    ~TestReadOnlyView() { if (value) UnmapViewOfFile(value); }
  };
  TestReadOnlyView normalReader;
  {
    Handle section(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, 32, nullptr));
    require(section.value != nullptr, "self_test_section_failed");
    DWORD sectionFlags = 0;
    expect(GetHandleInformation(section.value, &sectionFlags) && !(sectionFlags & HANDLE_FLAG_INHERIT));
    CpuMappingView view; view.open(section.value, 32);
    normalReader.open(section.value);
    expect(std::all_of(view.value, view.value + 32, [](unsigned char value) { return value == 0; }));
    std::memset(view.value, 0x7F, 32);
    expect(normalReader.value[0] == 0x7F && normalReader.value[31] == 0x7F);
    rejects([&] { view.open(section.value, 32); }); ++checks;
  }
  // The readonly parent view keeps the original section alive after both owner
  // mapping and owner handle are gone, with no concurrent teardown overwrite.
  expect(std::all_of(normalReader.value, normalReader.value + 32, [](unsigned char value) { return value == 0x7F; }));
  TestReadOnlyView exceptionReader;
  try {
    Handle section(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, 32, nullptr));
    require(section.value != nullptr, "self_test_section_failed");
    CpuMappingView view; view.open(section.value, 32); exceptionReader.open(section.value);
    std::memset(view.value, 0xA5, 32); throw Failure("test_view_unwind");
  } catch (const Failure&) {
    expect(exceptionReader.value && std::all_of(exceptionReader.value, exceptionReader.value + 32,
      [](unsigned char value) { return value == 0xA5; }));
  }
  struct TestDuplication {
    unsigned releases = 0;
    HRESULT result = S_OK;
    HRESULT ReleaseFrame() { ++releases; return result; }
  };
  TestDuplication frameOwner;
  {
    AcquiredFrame frame(&frameOwner);
    frame.release(); expect(frameOwner.releases == 0);
    frame.hold(); rejects([&] { frame.hold(); }); ++checks;
    frame.release(); frame.release(); expect(frameOwner.releases == 1);
    frame.hold(); // A stop before another acquisition still releases on exit.
  }
  expect(frameOwner.releases == 2);
  try {
    AcquiredFrame frame(&frameOwner); frame.hold(); throw Failure("test_unwind");
  } catch (const Failure&) { expect(frameOwner.releases == 3); }
  frameOwner.result = DXGI_ERROR_ACCESS_LOST;
  {
    AcquiredFrame frame(&frameOwner); frame.hold();
    rejects([&] { frame.release(); }); ++checks;
    frame.release(); expect(frameOwner.releases == 4);
  }
  expect(frameOwner.releases == 4); // Failed explicit release is not retried.
  {
    AcquiredFrame frame(&frameOwner); frame.hold();
  }
  expect(frameOwner.releases == 5); // Best-effort destructor never throws.
  ReadinessWindow readiness(8333);
  expect(readiness.open(0) && readiness.remaining(0) == 8333);
  expect(readiness.acquireTimeoutMs(0) == 1 && readiness.waitUs(0, 500) == 500);
  expect(readiness.remaining(7333) == 1000 && readiness.acquireTimeoutMs(7333) == 1);
  expect(readiness.acquireTimeoutMs(7334) == 0 && readiness.waitUs(7334, 2000) == 999);
  expect(readiness.remaining(8332) == 1 && readiness.waitUs(8332, 250) == 1);
  expect(!readiness.open(8333) && readiness.remaining(8333) == 0);
  expect(readiness.acquireTimeoutMs(8333) == 0 && readiness.waitUs(8333, 500) == 0);
  expect(!readiness.open(9000) && readiness.remaining(9000) == 0);
  ReadinessWindow completed(1000); completed.complete();
  expect(!completed.open(0) && completed.waitUs(0, 500) == 0);
  rejects([&] { completed.complete(); }); ++checks;
  rejects([&] { completed.cancel(); }); ++checks;
  ReadinessWindow cancelled(1000); cancelled.cancel(); cancelled.cancel();
  expect(!cancelled.open(0) && cancelled.acquireTimeoutMs(0) == 0);
  rejects([&] { cancelled.complete(); }); ++checks;
  const uint64_t lateDeadline = advanceTick(0, 20000, 8333);
  ReadinessWindow late(lateDeadline);
  expect(lateDeadline == 24999 && late.remaining(20000) == 4999);
  // A late wake gets only the remaining current phase, never historical work.
  expect(late.acquireTimeoutMs(24900) == 0 && late.waitUs(24900, 500) == 99);
  for (const auto& test : std::array<std::array<uint64_t, 4>, 9>{{
      {{100,99,10,100}}, {{100,100,10,110}}, {{100,103,10,110}},
      {{100,109,10,110}}, {{100,110,10,120}}, {{100,137,10,140}},
      {{100,199,10,200}}, {{100,200,10,210}}, {{100,1000007,10,1000010}}}}) {
    const auto next = advanceTick(test[0], test[1], test[2]);
    expect(next == test[3]);
    expect(next > test[1] && (next - test[0]) % test[2] == 0);
  }
  uint64_t phasedDue = 100;
  for (unsigned i = 0; i < 1000; ++i) phasedDue = advanceTick(phasedDue, phasedDue + 3, 10);
  expect(phasedDue == 10100); // Repeated late wakes do not accumulate phase drift.
  uint64_t missedDue = 100; unsigned captures = 0;
  for (unsigned i = 0; i < 4; ++i) if (137 >= missedDue) {
    ++captures; missedDue = advanceTick(missedDue, 137, 10);
  }
  expect(captures == 1 && missedDue == 140); // Missed ticks are not replayed.
  uint64_t processingDue = 100; captures = 0;
  for (uint64_t now : {100ULL,137ULL,138ULL,140ULL,190ULL,191ULL,200ULL}) {
    if (now >= processingDue) { ++captures; processingDue = advanceTick(processingDue, now, 10); }
    expect(processingDue > now);
  }
  expect(captures == 5 && processingDue == 210);
  rejects([] { advanceTick(100, 100, 0); }); ++checks;
  const uint64_t maximum = std::numeric_limits<uint64_t>::max();
  expect(advanceTick(maximum - 10, maximum - 1, 10) == maximum);
  rejects([&] { advanceTick(maximum, maximum, 1); }); ++checks;
  for (const auto& test : std::array<std::array<UINT, 6>, 6>{{
      {{2560,1600,960,540,864,540}}, {{3840,2160,960,540,960,540}},
      {{64,40,960,540,64,40}}, {{63,39,960,540,62,38}},
      {{1920,1080,800,600,800,450}}, {{2560,1600,1920,1080,1728,1080}}}}) {
    const auto result = scaledSize(test[0], test[1], test[2], test[3]);
    expect(result.width == test[4] && result.height == test[5]);
  }
  rejects([] { scaledSize(2, 16384, 2, 2); }); ++checks;
  rejects([] { decimal("9007199254740992", kSafeInteger, "invalid"); }); ++checks;
  rejects([] { decimal("-1", kSafeInteger, "invalid"); }); ++checks;
  expect(decimal("9007199254740991", kSafeInteger, "invalid") == kSafeInteger);
  Lease lease; lease.issue(1);
  rejects([&] { lease.issue(2); }); rejects([&] { lease.release(1); }); checks += 2;
  lease.import(1); rejects([&] { lease.import(1); }); ++checks;
  rejects([&] { lease.release(2); }); ++checks; lease.release(1); lease.issue(2); lease.import(2); lease.release(2);
  expect(!lease.busy);
  const auto command = parseCommand("imported 2 9007199254740991");
  expect(command.kind == Command::Imported && command.slot == 2 && command.serial == kSafeInteger);
  for (const auto* invalid : {"released 3 1", "imported 0 0", "stop ", "released 0 1 extra", "imported  1"}) {
    rejects([&] { parseCommand(invalid); }); ++checks;
  }
  DXGI_OUTDUPL_POINTER_SHAPE_INFO mono{}; mono.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  mono.Width = 4; mono.Height = 2; mono.Pitch = 2; mono.HotSpot = {3, 0};
  // Bits (AND,XOR) = 00,01,10,11 with a padded pitch, MSB first.
  const unsigned char mask[]{0x30, 0xCD, 0x50, 0xEF};
  const auto shape = decodeCursor(mono, mask, sizeof(mask));
  const Pixel base{0x35, 0xA6, 0x7F, 73};
  const std::array<Pixel, 4> expected{{{{0,0,0,73}}, {{255,255,255,73}}, base, {{202,89,128,73}}}};
  for (int x = 0; x < 4; ++x) expect(cursorReference(base, shape, x, 0) == expected[size_t(x)]);
  expect(cursorReference(base, shape, -1, 0) == base && cursorReference(base, shape, 4, 0) == base);
  auto badMono = mono; badMono.Height = 3; rejects([&] { decodeCursor(badMono, mask, sizeof(mask)); }); ++checks;
  badMono = mono; badMono.Pitch = MAXUINT; rejects([&] { decodeCursor(badMono, mask, sizeof(mask)); }); ++checks;
  DXGI_OUTDUPL_POINTER_SHAPE_INFO color{}; color.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  color.Width = 3; color.Height = 1; color.Pitch = 16;
  const unsigned char colors[]{10,20,30,0, 200,100,50,128, 10,20,30,255, 0,0,0,0};
  const auto colored = decodeCursor(color, colors, sizeof(colors));
  expect(cursorReference(base, colored, 0, 0) == base);
  const auto mixed = cursorReference(base, colored, 1, 0);
  expect(std::abs(mixed[0] - (200 * 128 + 53 * 127) / 255.0) < 1e-9 && mixed[3] == 73);
  expect(cursorReference(base, colored, 2, 0) == Pixel({10,20,30,73}));
  color.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
  rejects([&] { decodeCursor(color, colors, sizeof(colors)); }); ++checks;
  const unsigned char masked[]{10,20,30,0, 255,255,255,255, 0,0,0,255, 0,0,0,0};
  const auto maskedShape = decodeCursor(color, masked, sizeof(masked));
  expect(cursorReference(base, maskedShape, 0, 0) == Pixel({10,20,30,73}));
  expect(cursorReference(base, maskedShape, 1, 0) == Pixel({202,89,128,73}));
  expect(cursorReference(base, maskedShape, 2, 0) == base);
  color.Type = 99; rejects([&] { decodeCursor(color, colors, sizeof(colors)); }); ++checks;
  std::vector<Pixel> checker(8 * 6);
  for (UINT y = 0; y < 6; ++y) for (UINT x = 0; x < 8; ++x)
    checker[y * 8 + x] = {double((x + y) % 2) * 255, double(x) * 10, double(y) * 20, double(x + y) * 10};
  const auto identity = areaReference(checker, {8,6}, {8,6}); expect(identity == checker);
  const auto small = areaReference(checker, {8,6}, {4,2});
  expect(std::abs(small[0][0] - 127.5) < 1e-9 && std::abs(small[0][1] - 5) < 1e-9 &&
    std::abs(small[0][2] - 20) < 1e-9 && std::abs(small[0][3] - 15) < 1e-9);
  const auto odd = areaReference(checker, {8,6}, {6,4});
  double originalSum = 0, scaledSum = 0;
  for (const auto& pixel : checker) originalSum += pixel[3];
  for (const auto& pixel : odd) scaledSum += pixel[3];
  expect(std::abs(originalSum / checker.size() - scaledSum / odd.size()) < 1e-9);
  // CPU compiler only. Shader compilation is not a GPU execution/quality test.
  compile("vertexMain", "vs_4_0"); compile("horizontalMain", "ps_4_0"); compile("verticalMain", "ps_4_0"); checks += 3;
  compile("nv12LumaMain", "ps_4_0"); compile("nv12ChromaMain", "ps_4_0"); checks += 2;
  std::cout << "{\"type\":\"self-test\",\"passed\":true,\"cpuOnly\":true,\"checks\":" << checks << "}" << std::endl;
}
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--self-test") selfTest();
    else capture(options(argc, argv));
    return 0;
  } catch (const Failure& error) {
    // Only fixed compile-time stage codes leave the process: no OS source names,
    // raw HRESULT strings, pixels, screenshots or handles in errors/log files.
    std::cout << "{\"type\":\"error\",\"code\":\"" << error.what() << "\"}" << std::endl;
    return 2;
  } catch (...) {
    std::cout << "{\"type\":\"error\",\"code\":\"internal_failure\"}" << std::endl;
    return 2;
  }
}
