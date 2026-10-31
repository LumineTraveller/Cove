// Diagnostic only: no encoder, persistent pixels, desktop fallback or OS changes.
// Use the compiler's actual Windows SDK interfaces; never hand-code COM slots.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

static double qpcFrequency = 0;
static uint64_t fileTime(const FILETIME& value) {
  return (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
static std::string hexResult(HRESULT value) {
  std::ostringstream out;
  out << "0x" << std::hex << std::uppercase << uint32_t(value);
  return out.str();
}
static void check(HRESULT value, const char* operation) {
  if (FAILED(value)) throw std::runtime_error(std::string(operation) + ": " + hexResult(value));
}
static std::string jsonString(const std::string& value) {
  std::ostringstream out;
  out << '"';
  for (unsigned char ch : value) {
    if (ch == '"' || ch == '\\') out << '\\' << ch;
    else if (ch < 32) out << "\\u00" << std::hex << std::setw(2) << std::setfill('0') << unsigned(ch);
    else out << ch;
  }
  return out.str() + '"';
}

struct Stamp {
  LARGE_INTEGER wall{};
  ULONG64 cycles = 0;
  uint64_t kernel = 0, user = 0;
};
static Stamp stamp() {
  Stamp result;
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!QueryPerformanceCounter(&result.wall) ||
      !QueryThreadCycleTime(GetCurrentThread(), &result.cycles) ||
      !GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user))
    throw std::runtime_error("thread clock query failed");
  result.kernel = fileTime(kernel);
  result.user = fileTime(user);
  return result;
}
static double wallMs(const Stamp& begin, const Stamp& end) {
  return (end.wall.QuadPart - begin.wall.QuadPart) * 1000.0 / qpcFrequency;
}
struct Stage {
  std::vector<double> wall;
  double kernelMs = 0, userMs = 0;
  uint64_t cycles = 0;
  void add(const Stamp& begin, const Stamp& end) {
    wall.push_back(wallMs(begin, end));
    kernelMs += (end.kernel - begin.kernel) / 10000.0;
    userMs += (end.user - begin.user) / 10000.0;
    cycles += end.cycles - begin.cycles;
  }
  void print() const {
    auto sorted = wall;
    std::sort(sorted.begin(), sorted.end());
    double sum = 0;
    for (double value : wall) sum += value;
    auto percentile = [&](double fraction) {
      return sorted.empty() ? 0.0 : sorted[size_t((sorted.size() - 1) * fraction)];
    };
    std::cout << "{\"count\":" << wall.size() << ",\"wallTotalMs\":" << sum
      << ",\"wallMeanMs\":" << (wall.empty() ? 0.0 : sum / wall.size())
      << ",\"wallP50Ms\":" << percentile(.5) << ",\"wallP95Ms\":" << percentile(.95)
      << ",\"wallMaxMs\":" << (sorted.empty() ? 0.0 : sorted.back())
      << ",\"kernelTotalMs\":" << kernelMs << ",\"userTotalMs\":" << userMs
      << ",\"threadCpuTotalMs\":" << kernelMs + userMs
      << ",\"threadCpuMeanMs\":" << (wall.empty() ? 0.0 : (kernelMs + userMs) / wall.size())
      << ",\"threadCycles\":" << cycles << '}';
  }
};

struct Options {
  bool selfTestOnly = false;
  HWND window = nullptr;
  DWORD pid = 0;
  double seconds = 10;
  unsigned pollUs = 1000;
  unsigned focusWaitMs = 0;
  std::string mode = "readback-copy";
};
static void help() {
  std::cout << "DXGI capture microprofiler (diagnostic only)\n"
    "  --self-test\n"
    "  --profile --owned-hwnd 0xHEX --owned-pid PID [--seconds 10]\n"
    "            [--mode acquire-only|readback|readback-copy|gpu-scaled-readback-copy] [--poll-us 1000]\n"
    "The explicit owned source must remain visible, foreground and fullscreen.\n"
    "Profile first runs a 64x64 GPU roundtrip; no pixels are saved or printed.\n";
}
static Options parse(int argc, char** argv) {
  Options result;
  bool profile = false;
  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    if (arg == "--self-test" || arg == "--selftest") result.selfTestOnly = true;
    else if (arg == "--profile") profile = true;
    else {
      if (index + 1 >= argc) throw std::runtime_error("missing value for " + arg);
      const std::string value = argv[++index];
      if (arg == "--owned-hwnd") result.window = reinterpret_cast<HWND>(uintptr_t(std::stoull(value, nullptr, 0)));
      else if (arg == "--owned-pid") result.pid = DWORD(std::stoul(value));
      else if (arg == "--seconds") result.seconds = std::stod(value);
      else if (arg == "--poll-us") result.pollUs = unsigned(std::stoul(value));
      else if (arg == "--focus-wait-ms") result.focusWaitMs = unsigned(std::stoul(value));
      else if (arg == "--mode") result.mode = value;
      else throw std::runtime_error("unknown option " + arg);
    }
  }
  if (result.selfTestOnly == profile) throw std::runtime_error("choose exactly one of --self-test or --profile");
  if (!result.selfTestOnly && (!result.window || !result.pid)) throw std::runtime_error("profile requires explicit owned HWND and PID");
  if (!(result.seconds > 0 && result.seconds <= 60) || result.pollUs > 10000 || result.focusWaitMs > 20000)
    throw std::runtime_error("seconds must be 0..60; poll-us must be 0..10000");
  if (result.mode != "acquire-only" && result.mode != "readback" && result.mode != "readback-copy" &&
      result.mode != "gpu-scaled-readback-copy")
    throw std::runtime_error("unsupported mode");
  return result;
}

static bool ownedSource(const Options& options, const RECT& monitor) {
  DWORD pid = 0;
  RECT bounds{};
  return IsWindow(options.window) && IsWindowVisible(options.window) && !IsIconic(options.window) &&
    GetWindowThreadProcessId(options.window, &pid) && pid == options.pid &&
    GetForegroundWindow() == options.window && GetWindowRect(options.window, &bounds) &&
    bounds.left <= monitor.left && bounds.top <= monitor.top &&
    bounds.right >= monitor.right && bounds.bottom >= monitor.bottom;
}
static std::string sourceGuardReason(const Options& options, const RECT& monitor) {
  DWORD pid = 0; RECT bounds{};
  if (!IsWindow(options.window)) return "window_missing";
  if (!IsWindowVisible(options.window)) return "window_not_visible";
  if (IsIconic(options.window)) return "window_minimized";
  if (!GetWindowThreadProcessId(options.window, &pid) || pid != options.pid) return "owner_pid_mismatch";
  if (GetForegroundWindow() != options.window) return "window_not_foreground";
  if (!GetWindowRect(options.window, &bounds)) return "window_bounds_unavailable";
  if (bounds.left > monitor.left || bounds.top > monitor.top || bounds.right < monitor.right || bounds.bottom < monitor.bottom)
    return "window_does_not_cover_monitor";
  return "changed_between_guard_checks";
}

struct Output {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  DXGI_OUTPUT_DESC desc{};
};
static Output sourceOutput(const Options& options) {
  const HMONITOR monitor = MonitorFromWindow(options.window, MONITOR_DEFAULTTONULL);
  if (!monitor) throw std::runtime_error("owned source has no monitor");
  ComPtr<IDXGIFactory1> factory;
  check(CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf())), "CreateDXGIFactory1");
  for (UINT adapterIndex = 0;; ++adapterIndex) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT adapterResult = factory->EnumAdapters1(adapterIndex, adapter.GetAddressOf());
    if (adapterResult == DXGI_ERROR_NOT_FOUND) break;
    check(adapterResult, "EnumAdapters1");
    for (UINT outputIndex = 0;; ++outputIndex) {
      ComPtr<IDXGIOutput> output;
      const HRESULT outputResult = adapter->EnumOutputs(outputIndex, output.GetAddressOf());
      if (outputResult == DXGI_ERROR_NOT_FOUND) break;
      check(outputResult, "EnumOutputs");
      DXGI_OUTPUT_DESC desc{};
      check(output->GetDesc(&desc), "GetDesc(output)");
      if (desc.AttachedToDesktop && desc.Monitor == monitor) {
        Output result;
        result.adapter = adapter;
        check(output.As(&result.output), "QueryInterface(IDXGIOutput1)");
        result.desc = desc;
        return result;
      }
    }
  }
  throw std::runtime_error("no DXGI output matches the owned source monitor");
}
static void deviceFor(IDXGIAdapter* adapter, ComPtr<ID3D11Device>& device, ComPtr<ID3D11DeviceContext>& context) {
  check(D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
    nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
    device.GetAddressOf(), nullptr, context.GetAddressOf()), "D3D11CreateDevice(hardware; no WARP fallback)");
}
static ComPtr<ID3D11Texture2D> stagingTexture(ID3D11Device* device, D3D11_TEXTURE2D_DESC desc) {
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> result;
  check(device->CreateTexture2D(&desc, nullptr, result.GetAddressOf()), "CreateTexture2D(staging)");
  return result;
}
static Stage selfTest(ID3D11Device* device, ID3D11DeviceContext* context) {
  constexpr UINT width = 64, height = 64;
  std::vector<unsigned char> expected(width * height * 4);
  for (size_t index = 0; index < expected.size(); ++index) expected[index] = (index * 37 + index / 256) & 255;
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width; desc.Height = height; desc.MipLevels = 1; desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
  const D3D11_SUBRESOURCE_DATA initial{expected.data(), width * 4, 0};
  ComPtr<ID3D11Texture2D> source;
  check(device->CreateTexture2D(&desc, &initial, source.GetAddressOf()), "CreateTexture2D(selftest source)");
  auto staging = stagingTexture(device, desc);
  Stage timing;
  const auto begin = stamp();
  context->CopyResource(staging.Get(), source.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map(selftest)");
  bool matches = mapped.RowPitch >= width * 4;
  if (matches) for (UINT row = 0; row < height; ++row)
    matches = matches && std::memcmp(static_cast<unsigned char*>(mapped.pData) + size_t(row) * mapped.RowPitch,
      expected.data() + size_t(row) * width * 4, width * 4) == 0;
  context->Unmap(staging.Get(), 0);
  timing.add(begin, stamp());
  if (!matches) throw std::runtime_error("GPU texture roundtrip selftest mismatch (pixels suppressed)");
  return timing;
}

struct ScaledSize { UINT width = 0, height = 0; };
static ScaledSize bounded540(UINT width, UINT height) {
  if (width < 2 || height < 2) throw std::runtime_error("source too small for bounded even scaling");
  const UINT outputHeight = std::min(height, UINT(540)) / 2 * 2;
  const UINT outputWidth = UINT(uint64_t(width) * outputHeight / height) / 2 * 2;
  if (outputWidth < 2 || outputWidth > width || outputHeight > height)
    throw std::runtime_error("invalid bounded scale dimensions");
  return {outputWidth, outputHeight};
}
static ComPtr<ID3DBlob> compileShader(const char* text, const char* entry, const char* target) {
  ComPtr<ID3DBlob> result, errors;
  const HRESULT compiled = D3DCompile(text, std::strlen(text), "owned-synthetic-scale", nullptr, nullptr,
    entry, target, D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
    result.GetAddressOf(), errors.GetAddressOf());
  if (FAILED(compiled)) {
    const std::string detail = errors ? std::string(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize()) : "";
    throw std::runtime_error("D3DCompile: " + hexResult(compiled) + " " + detail);
  }
  return result;
}
class GpuScale {
  ComPtr<ID3D11Texture2D> source_, target_, staging_;
  ComPtr<ID3D11ShaderResourceView> sourceView_;
  ComPtr<ID3D11RenderTargetView> targetView_;
  ComPtr<ID3D11VertexShader> vertex_;
  ComPtr<ID3D11PixelShader> pixel_;
  ComPtr<ID3D11SamplerState> sampler_;
  ComPtr<ID3D11RasterizerState> rasterizer_;
  ComPtr<ID3D11DepthStencilState> depth_;
  ScaledSize size_;
public:
  GpuScale(ID3D11Device* device, D3D11_TEXTURE2D_DESC sourceDesc, ScaledSize size) : size_(size) {
    if (!size.width || !size.height || size.width > sourceDesc.Width || size.height > sourceDesc.Height)
      throw std::runtime_error("GPU scaling must not enlarge the source");
    sourceDesc.Usage = D3D11_USAGE_DEFAULT;
    sourceDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    sourceDesc.CPUAccessFlags = 0;
    sourceDesc.MiscFlags = 0;
    check(device->CreateTexture2D(&sourceDesc, nullptr, source_.GetAddressOf()), "CreateTexture2D(scale source)");
    check(device->CreateShaderResourceView(source_.Get(), nullptr, sourceView_.GetAddressOf()), "CreateShaderResourceView");
    auto targetDesc = sourceDesc;
    targetDesc.Width = size.width; targetDesc.Height = size.height;
    targetDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
    check(device->CreateTexture2D(&targetDesc, nullptr, target_.GetAddressOf()), "CreateTexture2D(scale target)");
    check(device->CreateRenderTargetView(target_.Get(), nullptr, targetView_.GetAddressOf()), "CreateRenderTargetView");
    staging_ = stagingTexture(device, targetDesc);
    static const char* shader = R"HLSL(
      struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
      Vertex vertexMain(uint id : SV_VertexID) {
        Vertex result;
        result.uv = float2((id << 1) & 2, id & 2);
        result.position = float4(result.uv * float2(2, -2) + float2(-1, 1), 0, 1);
        return result;
      }
      Texture2D<float4> sourceTexture : register(t0);
      SamplerState linearClamp : register(s0);
      float4 pixelMain(Vertex input) : SV_Target { return sourceTexture.SampleLevel(linearClamp, input.uv, 0); }
    )HLSL";
    const auto vs = compileShader(shader, "vertexMain", "vs_4_0");
    const auto ps = compileShader(shader, "pixelMain", "ps_4_0");
    check(device->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr, vertex_.GetAddressOf()), "CreateVertexShader");
    check(device->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr, pixel_.GetAddressOf()), "CreatePixelShader");
    D3D11_SAMPLER_DESC sampler{};
    sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.MaxLOD = 0;
    check(device->CreateSamplerState(&sampler, sampler_.GetAddressOf()), "CreateSamplerState");
    D3D11_RASTERIZER_DESC rasterizer{};
    rasterizer.FillMode = D3D11_FILL_SOLID; rasterizer.CullMode = D3D11_CULL_NONE;
    rasterizer.DepthClipEnable = TRUE;
    check(device->CreateRasterizerState(&rasterizer, rasterizer_.GetAddressOf()), "CreateRasterizerState");
    D3D11_DEPTH_STENCIL_DESC depth{};
    depth.DepthEnable = FALSE; depth.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
    depth.DepthFunc = D3D11_COMPARISON_ALWAYS; depth.StencilEnable = FALSE;
    check(device->CreateDepthStencilState(&depth, depth_.GetAddressOf()), "CreateDepthStencilState");
  }
  ID3D11Texture2D* source() const { return source_.Get(); }
  ID3D11Texture2D* target() const { return target_.Get(); }
  ComPtr<ID3D11Texture2D> staging() const { return staging_; }
  ScaledSize size() const { return size_; }
  void draw(ID3D11DeviceContext* context) const {
    const D3D11_VIEWPORT viewport{0, 0, FLOAT(size_.width), FLOAT(size_.height), 0, 1};
    ID3D11RenderTargetView* target = targetView_.Get();
    ID3D11ShaderResourceView* source = sourceView_.Get();
    ID3D11SamplerState* sampler = sampler_.Get();
    context->IASetInputLayout(nullptr);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertex_.Get(), nullptr, 0);
    context->PSSetShader(pixel_.Get(), nullptr, 0);
    context->RSSetState(rasterizer_.Get());
    context->RSSetViewports(1, &viewport);
    context->OMSetDepthStencilState(depth_.Get(), 0);
    context->OMSetBlendState(nullptr, nullptr, 0xFFFFFFFF);
    context->OMSetRenderTargets(1, &target, nullptr);
    context->PSSetShaderResources(0, 1, &source);
    context->PSSetSamplers(0, 1, &sampler);
    context->Draw(3, 0);
    // Remove both bindings before copying the result or writing the next source.
    ID3D11ShaderResourceView* none = nullptr;
    context->PSSetShaderResources(0, 1, &none);
    context->OMSetRenderTargets(0, nullptr, nullptr);
  }
};

struct ScaleTestCase {
  UINT sourceWidth = 0, sourceHeight = 0, width = 0, height = 0, rowPitch = 0, maxChannelError = 0;
};
static ScaleTestCase scaleTestCase(ID3D11Device* device, ID3D11DeviceContext* context,
                                 UINT width, UINT height, ScaledSize target) {
  std::vector<unsigned char> known(size_t(width) * height * 4);
  constexpr unsigned char quadrantBlue[] = {20, 80, 140, 220};
  constexpr unsigned char quadrantAlpha[] = {64, 128, 192, 255};
  for (UINT y = 0; y < height; ++y) for (UINT x = 0; x < width; ++x) {
    const unsigned quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
    auto* pixel = known.data() + (size_t(y) * width + x) * 4;
    pixel[0] = quadrantBlue[quadrant]; pixel[1] = unsigned(y * 255 / (height - 1));
    pixel[2] = unsigned(x * 255 / (width - 1)); pixel[3] = quadrantAlpha[quadrant];
  }
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width; desc.Height = height; desc.MipLevels = 1; desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
  const D3D11_SUBRESOURCE_DATA initial{known.data(), width * 4, 0};
  ComPtr<ID3D11Texture2D> source;
  check(device->CreateTexture2D(&desc, &initial, source.GetAddressOf()), "CreateTexture2D(scale selftest)");
  GpuScale scale(device, desc, target);
  context->CopyResource(scale.source(), source.Get());
  scale.draw(context);
  auto staging = scale.staging();
  context->CopyResource(staging.Get(), scale.target());
  D3D11_TEXTURE2D_DESC actual{}; staging->GetDesc(&actual);
  if (actual.Width != target.width || actual.Height != target.height || actual.Format != desc.Format)
    throw std::runtime_error("GPU scale selftest dimensions/format mismatch");
  D3D11_MAPPED_SUBRESOURCE mapped{};
  check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map(scale selftest)");
  if (mapped.RowPitch < target.width * 4) {
    context->Unmap(staging.Get(), 0);
    throw std::runtime_error("GPU scale selftest RowPitch too small");
  }
  UINT maximumError = 0;
  auto sample = [&](int x, int y, UINT channel) {
    x = std::max(0, std::min(int(width) - 1, x)); y = std::max(0, std::min(int(height) - 1, y));
    return double(known[(size_t(y) * width + x) * 4 + channel]);
  };
  // Compare every synthetic output pixel, including all corners and nonopaque
  // alpha. This is a tolerant bilinear reference, not a lossless-copy claim.
  for (UINT y = 0; y < target.height; ++y) for (UINT x = 0; x < target.width; ++x) {
    const double sx = (x + .5) * width / target.width - .5;
    const double sy = (y + .5) * height / target.height - .5;
    const int x0 = int(std::floor(sx)), y0 = int(std::floor(sy));
    const double fx = sx - x0, fy = sy - y0;
    for (UINT channel = 0; channel < 4; ++channel) {
      const double expected = (sample(x0, y0, channel) * (1 - fx) + sample(x0 + 1, y0, channel) * fx) * (1 - fy) +
        (sample(x0, y0 + 1, channel) * (1 - fx) + sample(x0 + 1, y0 + 1, channel) * fx) * fy;
      const auto actualValue = static_cast<const unsigned char*>(mapped.pData)[size_t(y) * mapped.RowPitch + x * 4 + channel];
      maximumError = std::max(maximumError, UINT(std::abs(int(actualValue) - int(std::lround(expected)))));
    }
  }
  context->Unmap(staging.Get(), 0);
  if (maximumError > 3) throw std::runtime_error("GPU scale bilinear/direction/alpha selftest mismatch (pixels suppressed)");
  return {width, height, target.width, target.height, mapped.RowPitch, maximumError};
}
static std::vector<ScaleTestCase> gpuScaleSelfTest(ID3D11Device* device, ID3D11DeviceContext* context) {
  const auto physical = bounded540(2560, 1600);
  const auto small = bounded540(64, 40);
  const auto odd = bounded540(63, 39);
  if (physical.width != 864 || physical.height != 540 || small.width != 64 || small.height != 40 ||
      odd.width != 60 || odd.height != 38) throw std::runtime_error("bounded scale dimension policy selftest failed");
  return {scaleTestCase(device, context, 64, 40, {32, 20}),
    scaleTestCase(device, context, 64, 40, small), scaleTestCase(device, context, 63, 39, odd)};
}
static void printScaleSelfTest(const std::vector<ScaleTestCase>& cases) {
  std::cout << "{\"passed\":true,\"channelTolerance\":3,\"fullFrameUv\":true,\"cases\":[";
  bool first = true;
  for (const auto& value : cases) {
    if (!first) std::cout << ',';
    first = false;
    std::cout << "{\"sourceWidth\":" << value.sourceWidth << ",\"sourceHeight\":" << value.sourceHeight
      << ",\"width\":" << value.width << ",\"height\":" << value.height << ",\"rowPitch\":" << value.rowPitch
      << ",\"checkedPixels\":" << value.width * value.height << ",\"maxChannelError\":" << value.maxChannelError << '}';
  }
  std::cout << "]}";
}

struct PollTimer {
  HANDLE handle = nullptr;
  explicit PollTimer(unsigned pollUs) {
    if (pollUs) {
      handle = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
      if (!handle) throw std::runtime_error("high-resolution local waitable timer unavailable; no coarse-sleep fallback");
    }
  }
  ~PollTimer() { if (handle) CloseHandle(handle); }
  void wait(unsigned pollUs) {
    if (!pollUs) { SwitchToThread(); return; }
    LARGE_INTEGER due{};
    due.QuadPart = -LONGLONG(pollUs) * 10;
    if (!SetWaitableTimer(handle, &due, 0, nullptr, nullptr, FALSE) || WaitForSingleObject(handle, INFINITE) != WAIT_OBJECT_0)
      throw std::runtime_error("local polling timer failed");
  }
};

static void profile(const Options& options) {
  auto output = sourceOutput(options);
  const auto focusDeadline = GetTickCount64() + options.focusWaitMs;
  // Activation may be supplied by the test coordinator. Never capture while
  // waiting, force another window's focus, or relax the ownership guard.
  while (!ownedSource(options, output.desc.DesktopCoordinates) && GetTickCount64() < focusDeadline)
    Sleep(50);
  if (!ownedSource(options, output.desc.DesktopCoordinates)) throw std::runtime_error("source_guard:" + sourceGuardReason(options, output.desc.DesktopCoordinates) + ";capture_not_started");
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  deviceFor(output.adapter.Get(), device, context);
  const auto selfTestTiming = selfTest(device.Get(), context.Get());
  const bool scaled = options.mode == "gpu-scaled-readback-copy";
  const auto scaleTests = scaled ? gpuScaleSelfTest(device.Get(), context.Get()) : std::vector<ScaleTestCase>{};
  if (!ownedSource(options, output.desc.DesktopCoordinates)) throw std::runtime_error("source_guard_after_selftest:" + sourceGuardReason(options, output.desc.DesktopCoordinates) + ";capture_not_started");
  ComPtr<IDXGIOutputDuplication> duplication;
  check(output.output->DuplicateOutput(device.Get(), duplication.GetAddressOf()), "DuplicateOutput");
  DXGI_OUTDUPL_DESC dupDesc{};
  duplication->GetDesc(&dupDesc);
  if (dupDesc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) throw std::runtime_error("unsupported duplication format");
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = dupDesc.ModeDesc.Width; desc.Height = dupDesc.ModeDesc.Height;
  desc.Format = dupDesc.ModeDesc.Format; desc.MipLevels = 1; desc.ArraySize = 1; desc.SampleDesc.Count = 1;
  const auto outputSize = scaled ? bounded540(desc.Width, desc.Height) : ScaledSize{desc.Width, desc.Height};
  std::unique_ptr<GpuScale> scaler;
  if (scaled) scaler = std::make_unique<GpuScale>(device.Get(), desc, outputSize);
  auto staging = scaled ? scaler->staging() : stagingTexture(device.Get(), desc);
  std::vector<unsigned char> copied(size_t(outputSize.width) * outputSize.height * 4);
  PollTimer timer(options.pollUs);
  Stage empty, acquireSuccess, acquireTimeout, copy, scaleDraw, targetCopy, map, cpuCopy, unmap, release, guard, backoff, iteration;
  for (int index = 0; index < 1000; ++index) { const auto begin = stamp(); empty.add(begin, stamp()); }
  uint64_t acquired = 0, desktopFrames = 0, pointerOnly = 0, timeouts = 0, accumulated = 0;
  uint64_t uniquePresents = 0, duplicatePresents = 0;
  LONGLONG lastPresentQpc = 0;
  UINT maxAccumulated = 0;
  bool frameHeld = false;
  std::string invalidReason;
  const auto runBegin = stamp();
  auto releaseHeld = [&] {
    if (!frameHeld) return;
    const auto begin = stamp();
    const HRESULT result = duplication->ReleaseFrame();
    release.add(begin, stamp());
    frameHeld = false;
    check(result, "ReleaseFrame");
  };
  try {
    while (wallMs(runBegin, stamp()) < options.seconds * 1000) {
      const auto guardBegin = stamp();
      const bool validSource = ownedSource(options, output.desc.DesktopCoordinates);
      guard.add(guardBegin, stamp());
      if (!validSource) { invalidReason = "owned_source_guard_lost"; break; }
      // All work using the prior desktop surface is finished. Keep release
      // adjacent to Acquire rather than releasing and sleeping between frames.
      releaseHeld();
      const auto frameBegin = stamp();
      DXGI_OUTDUPL_FRAME_INFO info{};
      ComPtr<IDXGIResource> resource;
      const auto acquireBegin = stamp();
      const HRESULT acquiredResult = duplication->AcquireNextFrame(0, &info, resource.GetAddressOf());
      const auto acquireEnd = stamp();
      if (acquiredResult == DXGI_ERROR_WAIT_TIMEOUT) {
        acquireTimeout.add(acquireBegin, acquireEnd); ++timeouts;
        const auto begin = stamp(); timer.wait(options.pollUs); backoff.add(begin, stamp());
        continue;
      }
      check(acquiredResult, "AcquireNextFrame(0)");
      acquireSuccess.add(acquireBegin, acquireEnd); frameHeld = true; ++acquired;
      if (!info.LastPresentTime.QuadPart) { ++pointerOnly; continue; }
      ++desktopFrames; accumulated += info.AccumulatedFrames;
      if (info.LastPresentTime.QuadPart > lastPresentQpc) {
        ++uniquePresents;
        lastPresentQpc = info.LastPresentTime.QuadPart;
      } else ++duplicatePresents;
      maxAccumulated = std::max(maxAccumulated, info.AccumulatedFrames);
      if (options.mode != "acquire-only") {
        ComPtr<ID3D11Texture2D> texture;
        check(resource.As(&texture), "QueryInterface(ID3D11Texture2D)");
        D3D11_TEXTURE2D_DESC actual{}; texture->GetDesc(&actual);
        if (actual.Width != desc.Width || actual.Height != desc.Height || actual.Format != desc.Format)
          throw std::runtime_error("duplication dimensions changed; no silent reconfiguration");
        auto begin = stamp();
        context->CopyResource(scaled ? scaler->source() : staging.Get(), texture.Get());
        copy.add(begin, stamp());
        if (scaled) {
          begin = stamp(); scaler->draw(context.Get()); scaleDraw.add(begin, stamp());
          begin = stamp(); context->CopyResource(staging.Get(), scaler->target()); targetCopy.add(begin, stamp());
        }
        D3D11_MAPPED_SUBRESOURCE mapped{};
        begin = stamp(); const HRESULT mapResult = context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped); map.add(begin, stamp());
        check(mapResult, "Map(readback)");
        if (mapped.RowPitch < outputSize.width * 4) { context->Unmap(staging.Get(), 0); throw std::runtime_error("invalid readback RowPitch"); }
        if (options.mode == "readback-copy" || scaled) {
          begin = stamp();
          for (UINT row = 0; row < outputSize.height; ++row)
            std::memcpy(copied.data() + size_t(row) * outputSize.width * 4,
              static_cast<unsigned char*>(mapped.pData) + size_t(row) * mapped.RowPitch, size_t(outputSize.width) * 4);
          // Prevent dead-store removal without exposing pixels or a content hash.
          __asm__ __volatile__("" : : "r"(copied.data()) : "memory");
          cpuCopy.add(begin, stamp());
        }
        begin = stamp(); context->Unmap(staging.Get(), 0); unmap.add(begin, stamp());
      }
      iteration.add(frameBegin, stamp());
    }
    releaseHeld();
  } catch (...) {
    if (frameHeld) duplication->ReleaseFrame();
    SecureZeroMemory(copied.data(), copied.size());
    throw;
  }
  const auto runEnd = stamp();
  // Outside all capture/CPU-copy timings, including the overall run interval.
  SecureZeroMemory(copied.data(), copied.size());
  check(device->GetDeviceRemovedReason(), "GetDeviceRemovedReason");
  const double elapsed = wallMs(runBegin, runEnd);
  std::cout << std::fixed << std::setprecision(6)
    << "{\"schemaVersion\":1,\"mode\":" << jsonString(options.mode)
    << ",\"valid\":" << (invalidReason.empty() ? "true" : "false")
    << ",\"invalidReason\":" << jsonString(invalidReason)
    << ",\"sourceGuard\":\"explicit-owned-hwnd-pid-visible-fullscreen-foreground\",\"ownedPid\":" << options.pid
    << ",\"pixelsPersisted\":false,\"captureTimeoutMs\":0,\"pollUs\":" << options.pollUs
    << ",\"width\":" << desc.Width << ",\"height\":" << desc.Height
    << ",\"outputWidth\":" << outputSize.width << ",\"outputHeight\":" << outputSize.height
    << ",\"cpuFrameBytes\":" << copied.size()
    << ",\"desktopImageInSystemMemory\":" << (dupDesc.DesktopImageInSystemMemory ? "true" : "false")
    << ",\"elapsedMs\":" << elapsed << ",\"acquiredFrames\":" << acquired
    << ",\"desktopFrames\":" << desktopFrames << ",\"pointerOnlyFrames\":" << pointerOnly
    << ",\"uniqueLastPresentTimeCount\":" << uniquePresents << ",\"duplicatePresentFrames\":" << duplicatePresents
    << ",\"timeouts\":" << timeouts << ",\"accumulatedFrames\":" << accumulated
    << ",\"maxAccumulatedFrames\":" << maxAccumulated
    << ",\"desktopFps\":" << uniquePresents * 1000.0 / elapsed
    << ",\"processedDesktopFps\":" << desktopFrames * 1000.0 / elapsed
    << ",\"threadCpuMs\":" << (runEnd.kernel + runEnd.user - runBegin.kernel - runBegin.user) / 10000.0
    << ",\"threadCycles\":" << runEnd.cycles - runBegin.cycles
    << ",\"selfTest\":{\"passed\":true,\"size\":\"64x64\",\"roundtrip\":";
  selfTestTiming.print(); std::cout << '}';
  if (scaled) { std::cout << ",\"gpuScaleSelfTest\":"; printScaleSelfTest(scaleTests); }
  std::cout << ",\"stages\":{";
  bool first = true;
  auto printStage = [&](const char* name, const Stage& stage) {
    if (!first) std::cout << ',';
    first = false;
    std::cout << jsonString(name) << ':'; stage.print();
  };
  printStage("emptyClockPair", empty); printStage("acquireSuccess", acquireSuccess);
  printStage("acquireTimeout", acquireTimeout); printStage("copyResource", copy);
  printStage("gpuScaleDrawSubmission", scaleDraw); printStage("scaledStagingCopySubmission", targetCopy);
  printStage("mapReadback", map); printStage("cpuRowCopy", cpuCopy); printStage("unmap", unmap);
  printStage("releaseFrame", release); printStage("ownershipGuard", guard); printStage("pollBackoff", backoff);
  printStage("desktopIteration", iteration); std::cout << "}}\n";
  if (!invalidReason.empty()) throw std::runtime_error("profile invalid: " + invalidReason);
}

int main(int argc, char** argv) {
  if (argc == 1 || (argc == 2 && std::string(argv[1]) == "--help")) { help(); return 0; }
  try {
    const Options options = parse(argc, argv);
    LARGE_INTEGER frequency{};
    if (!QueryPerformanceFrequency(&frequency)) throw std::runtime_error("QPC unavailable");
    qpcFrequency = double(frequency.QuadPart);
    if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
        !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
      throw std::runtime_error("per-monitor-v2 DPI awareness unavailable; refusing ambiguous source coordinates");
    if (options.selfTestOnly) {
      ComPtr<ID3D11Device> device;
      ComPtr<ID3D11DeviceContext> context;
      deviceFor(nullptr, device, context);
      const auto timing = selfTest(device.Get(), context.Get());
      const auto scaleTests = gpuScaleSelfTest(device.Get(), context.Get());
      std::cout << "{\"schemaVersion\":1,\"mode\":\"self-test\",\"valid\":true,\"passed\":true,\"size\":\"64x64\",\"pixelsPersisted\":false,\"roundtrip\":";
      timing.print(); std::cout << ",\"gpuScaleSelfTest\":"; printScaleSelfTest(scaleTests); std::cout << "}\n";
    } else profile(options);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "{\"valid\":false,\"error\":" << jsonString(error.what()) << "}\n";
    return 2;
  }
}
