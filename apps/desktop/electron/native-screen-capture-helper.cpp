// Experimental Windows GPU capture provider. No full-frame CPU-accessible texture,
// encoder, image pipe, OS timer change, restart loop or automatic source fallback.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <d3d11.h>
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
struct Options { DWORD owner = 0; UINT maxWidth = 0, maxHeight = 0, fps = 0; };
static Options options(int argc, char** argv) {
  require(argc == 9, "invalid_arguments");
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
    } else require(false, "invalid_arguments");
    require(!(seen & bit), "invalid_arguments"); seen |= bit;
  }
  require(seen == 15 && result.owner && result.maxWidth >= 2 && result.maxHeight >= 2 &&
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
class Timer {
  Handle handle_;
public:
  Timer() : handle_(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
      TIMER_MODIFY_STATE | SYNCHRONIZE)) { require(handle_.value != nullptr, "timer_unavailable"); }
  void wait(HANDLE owner, uint64_t us) {
    LARGE_INTEGER due{}; due.QuadPart = -LONGLONG(std::max<uint64_t>(1, std::min<uint64_t>(us, 2000))) * 10;
    require(SetWaitableTimer(handle_.value, &due, 0, nullptr, nullptr, FALSE), "timer_failed");
    HANDLE objects[]{owner, handle_.value};
    const DWORD result = WaitForMultipleObjects(2, objects, FALSE, 100);
    require(result == WAIT_OBJECT_0 + 1, result == WAIT_OBJECT_0 ? "owner_exited" : "timer_failed");
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
struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11RenderTargetView> target;
  ComPtr<IDXGIKeyedMutex> mutex;
  Handle local;
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
  ComPtr<ID3D11PixelShader> horizontal_, vertical_;
  ComPtr<ID3D11Buffer> constants_;
  ComPtr<ID3D11RasterizerState> rasterizer_;
  ComPtr<ID3D11DepthStencilState> depth_;
  ComPtr<ID3D11ShaderResourceView> sourceView_, intermediateView_, cursorView_;
  ComPtr<ID3D11RenderTargetView> intermediateTarget_;
  ComPtr<ID3D11Texture2D> intermediate_, cursorTexture_;
  std::vector<unsigned char> cursorBytes_;
public:
  ComPtr<ID3D11Texture2D> desktop;
  Constants values;
  Pipeline(ID3D11Device* device, Size source, Size target)
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
};
class AcquiredFrame {
  IDXGIOutputDuplication* duplication_;
  bool held_ = false;
public:
  explicit AcquiredFrame(IDXGIOutputDuplication* duplication) : duplication_(duplication) {}
  void hold() { held_ = true; }
  void release() {
    if (!held_) return;
    held_ = false; check(duplication_->ReleaseFrame(), "frame_release_failed");
  }
  ~AcquiredFrame() { if (held_) duplication_->ReleaseFrame(); }
};
static bool gpuComplete(ID3D11DeviceContext* context, ID3D11Query* query, HANDLE owner,
    Timer& timer, Input& input, std::array<Slot, 3>& slots, const Clock& clock) {
  context->End(query); context->Flush();
  const uint64_t deadline = clock.us() + 500000;
  while (true) {
    const HRESULT result = context->GetData(query, nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) return true;
    require(result == S_FALSE, "gpu_completion_failed");
    require(clock.us() < deadline, "gpu_completion_timeout");
    if (!input.pump(owner, slots)) return false;
    timer.wait(owner, 1000);
  }
}
static void createSlot(ID3D11Device* device, Slot& slot, Size size) {
  auto desc = textureDesc(size.width, size.height, DXGI_FORMAT_B8G8R8A8_UNORM,
    D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE);
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  check(device->CreateTexture2D(&desc, nullptr, slot.texture.GetAddressOf()), "shared_texture_failed");
  check(device->CreateRenderTargetView(slot.texture.Get(), nullptr, slot.target.GetAddressOf()), "shared_target_failed");
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
  Clock clock; Timer timer; Input input;
  auto output = primaryOutput();
  const Size source{UINT(output.desc.DesktopCoordinates.right), UINT(output.desc.DesktopCoordinates.bottom)};
  const auto size = scaledSize(source.width, source.height, option.maxWidth, option.maxHeight);
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_0};
  check(D3D11CreateDevice(output.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 1, D3D11_SDK_VERSION,
    device.GetAddressOf(), nullptr, context.GetAddressOf()), "hardware_device_failed");
  Pipeline pipeline(device.Get(), source, size);
  std::array<Slot, 3> slots;
  for (auto& slot : slots) createSlot(device.Get(), slot, size);
  ComPtr<ID3D11Query> completion; const D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
  check(device->CreateQuery(&query, completion.GetAddressOf()), "completion_query_failed");
  validateOutput(output);
  ComPtr<IDXGIOutputDuplication> duplication;
  check(output.output->DuplicateOutput(device.Get(), duplication.GetAddressOf()), "duplication_failed");
  DXGI_OUTDUPL_DESC duplicationDesc{}; duplication->GetDesc(&duplicationDesc);
  require(duplicationDesc.ModeDesc.Width == source.width && duplicationDesc.ModeDesc.Height == source.height &&
    duplicationDesc.ModeDesc.Format == DXGI_FORMAT_B8G8R8A8_UNORM &&
    duplicationDesc.Rotation == DXGI_MODE_ROTATION_IDENTITY, "unsupported_duplication_geometry");
  // Protocol 2 handles belong to this helper's table. The main-process native
  // bridge duplicates them synchronously and uniquely closes its local copy.
  // This process never creates an unowned handle in its parent's handle table.
  std::cout << "{\"type\":\"ready\",\"protocol\":2,\"width\":" << size.width << ",\"height\":" << size.height
    << ",\"sourceWidth\":" << source.width << ",\"sourceHeight\":" << source.height
    << ",\"poolSize\":3,\"cursorSupported\":true}" << std::endl;
  require(bool(std::cout), "owner_output_closed");
  uint64_t serial = 0, lastTimestamp = 0, nextTick = clock.us(), lastSent = 0, nextDisplayCheck = 0;
  uint64_t newFrames = 0, refreshFrames = 0, backpressureTicks = 0;
  LONGLONG lastPresent = 0, lastMouse = 0;
  bool haveDesktop = false, haveShape = false, dirty = false;
  const uint64_t period = 1000000 / option.fps;
  bool running = true;
  while (running) {
    if (!input.pump(owner.value, slots)) break;
    uint64_t now = clock.us();
    for (const auto& slot : slots) require(!slot.lease.busy || now - slot.sentAt < 10000000,
      "slot_release_timeout");
    if (now < nextTick) { timer.wait(owner.value, nextTick - now); continue; }
    // One latest-frame acquisition per due tick; skip missed ticks and preserve
    // the original phase instead of accumulating each timer wake's lateness.
    nextTick = advanceTick(nextTick, now, period);
    if (now >= nextDisplayCheck) {
      validateOutput(output); check(device->GetDeviceRemovedReason(), "gpu_device_lost");
      nextDisplayCheck = now + 250000;
    } else validateOutputFast(output);
    auto available = std::find_if(slots.begin(), slots.end(), [](const Slot& slot) { return !slot.lease.busy; });
    if (available == slots.end()) { ++backpressureTicks; continue; }
    AcquiredFrame acquired(duplication.Get());
    DXGI_OUTDUPL_FRAME_INFO info{}; ComPtr<IDXGIResource> resource;
    const HRESULT result = duplication->AcquireNextFrame(0, &info, resource.GetAddressOf());
    if (result != DXGI_ERROR_WAIT_TIMEOUT) {
      check(result, "desktop_acquire_failed"); acquired.hold();
      if (info.LastPresentTime.QuadPart > lastPresent || !haveDesktop) {
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
    const bool refresh = !dirty && haveDesktop && now - lastSent >= 250000;
    if (!haveDesktop || (!dirty && !refresh)) { acquired.release(); continue; }
    auto& slot = *available;
    // Key 0 matches Electron's DXGI shared texture import. Credits, rather than
    // mutex availability alone, govern reuse while encoder references exist.
    require(slot.mutex->AcquireSync(0, 0) == S_OK, "shared_mutex_unavailable");
    bool locked = true;
    try {
      pipeline.draw(context.Get(), slot.target.Get());
      running = gpuComplete(context.Get(), completion.Get(), owner.value, timer, input, slots, clock);
      check(slot.mutex->ReleaseSync(0), "shared_mutex_release_failed"); locked = false;
    } catch (...) { if (locked) slot.mutex->ReleaseSync(0); throw; }
    acquired.release();
    if (!running) break;
    check(device->GetDeviceRemovedReason(), "gpu_device_lost");
    validateOutputFast(output);
    require(serial < kSafeInteger, "serial_exhausted");
    slot.lease.issue(++serial); slot.sentAt = clock.us();
    const uint64_t timestamp = std::max(lastTimestamp + 1, slot.sentAt);
    require(timestamp <= kSafeInteger, "timestamp_exhausted"); lastTimestamp = timestamp;
    const auto index = size_t(std::distance(slots.begin(), available));
    std::cout << "{\"type\":\"frame\",\"slot\":" << index << ",\"serial\":" << serial << ",\"handle\":\"0x"
      << std::hex << uintptr_t(slot.local.value) << std::dec << "\",\"timestamp\":" << timestamp
      << ",\"width\":" << size.width << ",\"height\":" << size.height
      << ",\"refresh\":" << (refresh ? "true" : "false") << "}" << std::endl;
    require(bool(std::cout), "owner_output_closed");
    if (refresh) ++refreshFrames; else ++newFrames;
    dirty = false; lastSent = slot.sentAt;
  }
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
