// Isolated 64x64 BGRA -> NV12 pixel-shader feasibility probe.
// No desktop API, encoder, network, production provider or full-size readback.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <d3d11_4.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <exception>
#include <iostream>
#include <string>

using Microsoft::WRL::ComPtr;
constexpr UINT kWidth = 64, kHeight = 64;
constexpr const char* kProbe = "nv12-pixel-shader";
static HRESULT lastHr = S_OK;
static HRESULT removedReason = S_OK;
class Failure final : public std::exception {
  const char* code_;
public:
  explicit Failure(const char* code) : code_(code) {}
  const char* what() const noexcept override { return code_; }
};
static void require(bool condition, const char* code) { if (!condition) throw Failure(code); }
static void check(HRESULT value, const char* code) {
  if (FAILED(value)) { lastHr = value; throw Failure(code); }
}
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(const Handle&) = delete;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Library {
  HMODULE value = nullptr;
  Library() = default;
  Library(const Library&) = delete;
  Library(Library&& other) noexcept : value(other.value) { other.value = nullptr; }
  ~Library() { if (value) FreeLibrary(value); }
};
static void stage(const char* name) {
  std::cout << "{\"type\":\"stage\",\"probe\":\"" << kProbe << "\",\"stage\":\"" << name << "\"}" << std::endl;
  require(bool(std::cout), "owner_output_closed");
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
struct Options {
  DWORD ownerPid = 0;
  bool producerOnly = false;
  bool share = false;
  bool releaseBeforeQuery = true;
};
static Options parseOptions(int argc, char** argv) {
  Options result; bool syncSeen = false;
  for (int index = 1; index < argc; ++index) {
    const std::string argument(argv[index]);
    if (argument == "--owner-pid") {
      require(!result.ownerPid && ++index < argc, "invalid_owner_pid");
      const std::string number(argv[index]);
      require(!number.empty() && number.size() <= 10, "invalid_owner_pid");
      uint64_t value = 0;
      for (char digit : number) {
        require(digit >= '0' && digit <= '9', "invalid_owner_pid");
        value = value * 10 + unsigned(digit - '0');
        require(value <= MAXDWORD, "invalid_owner_pid");
      }
      require(value != 0, "invalid_owner_pid"); result.ownerPid = DWORD(value);
    } else if (argument == "--producer-only") {
      require(!result.producerOnly, "duplicate_mode"); result.producerOnly = true;
    } else if (argument == "--share") {
      require(!result.share, "duplicate_mode"); result.share = true;
    } else if (argument == "--sync-mode") {
      require(!syncSeen && ++index < argc, "invalid_sync_mode"); syncSeen = true;
      const std::string mode(argv[index]);
      require(mode == "held-query" || mode == "released-query", "invalid_sync_mode");
      result.releaseBeforeQuery = mode == "released-query";
    } else throw Failure("invalid_arguments");
  }
  require(result.ownerPid && result.ownerPid == parentPid(), "owner_is_not_parent");
  require(result.producerOnly != result.share && syncSeen, "explicit_probe_mode_required");
  return result;
}
static bool alive(HANDLE owner) { return WaitForSingleObject(owner, 0) == WAIT_TIMEOUT; }
static std::string command(HANDLE owner, ULONGLONG deadline) {
  std::string line;
  while (GetTickCount64() < deadline) {
    require(alive(owner), "owner_exited");
    DWORD available = 0; const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    require(PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr), "owner_pipe_closed");
    if (!available) { Sleep(2); continue; }
    require(available <= 1024, "owner_command_overflow");
    char byte = 0; DWORD read = 0;
    require(ReadFile(input, &byte, 1, &read, nullptr) && read == 1, "owner_pipe_closed");
    if (byte == '\n') return line;
    if (byte != '\r') line += byte;
    require(line.size() <= 32, "owner_command_overflow");
  }
  throw Failure("owner_command_timeout");
}

using Pixel = std::array<unsigned char, 4>;
static Pixel sourcePixel(UINT x, UINT y) {
  // BGRA bytes. The checker region intentionally varies within each 2x2 block.
  static constexpr unsigned char grays[]{0,32,64,96,128,160,192,255};
  static constexpr Pixel colors[]{
    {{0,0,255,255}}, {{0,255,0,255}}, {{255,0,0,255}}, {{255,255,255,255}},
    {{0,0,0,255}}, {{255,255,0,255}}, {{255,0,255,255}}, {{0,255,255,255}},
  };
  if (y >= 24 && y < 40) {
    const unsigned char gray = grays[x / 8]; return {gray,gray,gray,255};
  }
  if (y >= 44 && y < 52) return colors[x / 8];
  if (y >= 52 && y < 60) return colors[(y % 2) * 2 + x % 2];
  return colors[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)];
}
static std::array<unsigned char, kWidth * kHeight * 4> sourcePixels() {
  std::array<unsigned char, kWidth * kHeight * 4> pixels{};
  for (UINT y = 0; y < kHeight; ++y) for (UINT x = 0; x < kWidth; ++x) {
    const auto pixel = sourcePixel(x, y);
    for (UINT channel = 0; channel < 4; ++channel) pixels[(y * kWidth + x) * 4 + channel] = pixel[channel];
  }
  return pixels;
}
static std::array<double, 3> rgb(const Pixel& pixel) {
  return {pixel[2] / 255.0, pixel[1] / 255.0, pixel[0] / 255.0};
}
static std::array<double, 3> rec709(const std::array<double, 3>& color) {
  const double yn = .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
  return {16.0 + 219.0 * yn, 128.0 + 224.0 * (color[2] - yn) / (2.0 * (1.0 - .0722)),
    128.0 + 224.0 * (color[0] - yn) / (2.0 * (1.0 - .2126))};
}
static int quantize(double value) { return int(std::floor(std::clamp(value, 0.0, 255.0) + .5)); }
static std::array<double, 3> blockRgb(UINT x, UINT y) {
  std::array<double, 3> average{};
  for (UINT dy = 0; dy < 2; ++dy) for (UINT dx = 0; dx < 2; ++dx) {
    const auto sample = rgb(sourcePixel(x * 2 + dx, y * 2 + dy));
    for (UINT channel = 0; channel < 3; ++channel) average[channel] += sample[channel] * .25;
  }
  return average;
}
static constexpr const char* kShader = R"hlsl(
Texture2D<float4> source : register(t0);
float4 vertex(uint id : SV_VertexID) : SV_Position {
  float2 p = float2((id << 1) & 2, id & 2);
  return float4(p * float2(2, -2) + float2(-1, 1), 0, 1);
}
float3 convert709(float3 rgb) {
  float y = dot(rgb, float3(.2126, .7152, .0722));
  return float3(16 + 219 * y, 128 + 224 * (rgb.b - y) / (2 * (1 - .0722)),
    128 + 224 * (rgb.r - y) / (2 * (1 - .2126))) / 255;
}
float4 luma(float4 position : SV_Position) : SV_Target {
  float3 rgb = source.Load(int3(int2(position.xy), 0)).rgb;
  return float4(convert709(rgb).x, 0, 0, 1);
}
float4 chroma(float4 position : SV_Position) : SV_Target {
  int2 p = int2(position.xy) * 2;
  float3 rgb = (source.Load(int3(p, 0)).rgb + source.Load(int3(p + int2(1,0), 0)).rgb
    + source.Load(int3(p + int2(0,1), 0)).rgb + source.Load(int3(p + int2(1,1), 0)).rgb) * .25;
  return float4(convert709(rgb).yz, 0, 1);
}
)hlsl";
// Keep the compiler module loaded until all blobs using its vtables are gone.
struct Shaders { Library compiler; ComPtr<ID3DBlob> vertex, luma, chroma; };
static Shaders compileShaders() {
  Shaders result;
  result.compiler.value = LoadLibraryExW(L"d3dcompiler_47.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  require(result.compiler.value != nullptr, "system_hlsl_compiler_unavailable");
  const FARPROC address = GetProcAddress(result.compiler.value, "D3DCompile");
  pD3DCompile compile = nullptr;
  static_assert(sizeof(compile) == sizeof(address), "Windows function pointer sizes must match");
  std::memcpy(&compile, &address, sizeof(compile));
  require(compile != nullptr, "system_hlsl_compile_api_unavailable");
  const auto one = [&](const char* entry, const char* target, ComPtr<ID3DBlob>& code) {
    ComPtr<ID3DBlob> errors;
    check(compile(kShader, std::char_traits<char>::length(kShader), "synthetic-nv12-shader", nullptr, nullptr,
      entry, target, D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_WARNINGS_ARE_ERRORS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
      0, code.GetAddressOf(), errors.GetAddressOf()), "hlsl_compilation_failed");
    // Compiler text is intentionally not included in persistent diagnostics.
  };
  one("vertex", "vs_5_0", result.vertex); one("luma", "ps_5_0", result.luma); one("chroma", "ps_5_0", result.chroma);
  return result;
}
static void selfTest() {
  require(sourcePixel(8,8) == Pixel{0,0,255,255} && sourcePixel(56,8) == Pixel{0,255,0,255}, "pattern_self_test_failed");
  auto pixels = sourcePixels();
  for (size_t index = 3; index < pixels.size(); index += 4) require(pixels[index] == 255, "pattern_alpha_self_test_failed");
  SecureZeroMemory(pixels.data(), pixels.size());
  require(quantize(rec709({0,0,0})[0]) == 16 && quantize(rec709({1,1,1})[0]) == 235, "reference_luma_self_test_failed");
  const auto average = blockRgb(0,26);
  for (double value : average) require(std::abs(value - .5) < 1e-12, "reference_chroma_self_test_failed");
  const auto neutral = rec709(average);
  require(quantize(neutral[1]) == 128 && quantize(neutral[2]) == 128, "reference_neutral_self_test_failed");
  const auto shaders = compileShaders();
  require(shaders.vertex && shaders.luma && shaders.chroma, "hlsl_self_test_failed");
  std::cout << "{\"type\":\"self-test\",\"probe\":\"" << kProbe
    << "\",\"passed\":true,\"cpuPatternPassed\":true,\"hlslCompilePassed\":true,\"gpuExecuted\":false}" << std::endl;
}
static void gpuComplete(ID3D11Device* device, ID3D11DeviceContext* context, HANDLE owner) {
  D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT, 0}; ComPtr<ID3D11Query> query;
  check(device->CreateQuery(&desc, query.GetAddressOf()), "gpu_query_create_failed");
  context->End(query.Get()); context->Flush();
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT result = context->GetData(query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) break;
    if (result != S_FALSE) { removedReason = device->GetDeviceRemovedReason(); check(result, "gpu_completion_failed"); }
    require(alive(owner), "owner_exited");
    if (GetTickCount64() >= deadline) {
      removedReason = device->GetDeviceRemovedReason(); throw Failure("gpu_completion_timeout");
    }
    Sleep(1);
  }
  check(device->GetDeviceRemovedReason(), "gpu_device_lost");
}
struct Validation { int yMaxError = 0, uvMaxError = 0; };
static Validation validate(ID3D11DeviceContext* context, ID3D11Texture2D* staging) {
  D3D11_MAPPED_SUBRESOURCE mapped{};
  check(context->Map(staging, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped), "synthetic_staging_map_failed");
  Validation result;
  try {
    require(mapped.pData && mapped.RowPitch >= kWidth, "synthetic_staging_layout_invalid");
    const auto* bytes = static_cast<const unsigned char*>(mapped.pData);
    for (UINT y = 0; y < kHeight; ++y) for (UINT x = 0; x < kWidth; ++x) {
      const int expected = quantize(rec709(rgb(sourcePixel(x,y)))[0]);
      result.yMaxError = std::max(result.yMaxError, std::abs(int(bytes[y * mapped.RowPitch + x]) - expected));
    }
    const auto* uv = bytes + mapped.RowPitch * kHeight;
    for (UINT y = 0; y < kHeight / 2; ++y) for (UINT x = 0; x < kWidth / 2; ++x) {
      const auto expected = rec709(blockRgb(x,y));
      for (UINT channel = 0; channel < 2; ++channel) {
        result.uvMaxError = std::max(result.uvMaxError,
          std::abs(int(uv[y * mapped.RowPitch + x * 2 + channel]) - quantize(expected[channel + 1])));
      }
    }
    require(result.yMaxError <= 1 && result.uvMaxError <= 1, "synthetic_rec709_pixels_mismatch");
  } catch (...) { context->Unmap(staging, 0); throw; }
  context->Unmap(staging, 0); return result;
}

static void probe(const Options& options) {
  Handle owner(OpenProcess(SYNCHRONIZE, FALSE, options.ownerPid));
  require(owner.value && alive(owner.value), "owner_unavailable");
  const auto shaders = compileShaders(); stage("hlsl_compiled");
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL requested[]{D3D_FEATURE_LEVEL_11_0}; D3D_FEATURE_LEVEL actual{};
  check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    requested, 1, D3D11_SDK_VERSION, device.GetAddressOf(), &actual, context.GetAddressOf()), "hardware_device_unsupported");
  require(actual >= D3D_FEATURE_LEVEL_11_0, "feature_level_11_required");
  ComPtr<ID3D11Device3> device3; check(device.As(&device3), "device3_plane_views_unsupported");
  stage("hardware_device3_created");
  D3D11_FEATURE_DATA_D3D11_OPTIONS4 options4{};
  const bool options4Known = SUCCEEDED(device->CheckFeatureSupport(D3D11_FEATURE_D3D11_OPTIONS4, &options4, sizeof(options4)));
  UINT nv12Support = 0, r8Support = 0, rg8Support = 0;
  check(device->CheckFormatSupport(DXGI_FORMAT_NV12, &nv12Support), "nv12_format_query_failed");
  check(device->CheckFormatSupport(DXGI_FORMAT_R8_UNORM, &r8Support), "r8_format_query_failed");
  check(device->CheckFormatSupport(DXGI_FORMAT_R8G8_UNORM, &rg8Support), "rg8_format_query_failed");
  // Actual texture/plane-view creation gates this exact combination. Options4
  // describes extended sharing capabilities and is recorded independently.
  D3D11_TEXTURE2D_DESC inputDesc{};
  inputDesc.Width = kWidth; inputDesc.Height = kHeight; inputDesc.MipLevels = 1; inputDesc.ArraySize = 1;
  inputDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; inputDesc.SampleDesc.Count = 1;
  inputDesc.Usage = D3D11_USAGE_DEFAULT; inputDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  auto pixels = sourcePixels(); const D3D11_SUBRESOURCE_DATA initial{pixels.data(), kWidth * 4, 0};
  ComPtr<ID3D11Texture2D> input;
  const HRESULT createdInput = device->CreateTexture2D(&inputDesc, &initial, input.GetAddressOf());
  SecureZeroMemory(pixels.data(), pixels.size()); check(createdInput, "synthetic_bgra_texture_failed");
  ComPtr<ID3D11ShaderResourceView> inputView;
  check(device->CreateShaderResourceView(input.Get(), nullptr, inputView.GetAddressOf()), "synthetic_bgra_srv_failed");
  auto outputDesc = inputDesc; outputDesc.Format = DXGI_FORMAT_NV12;
  outputDesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  outputDesc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  ComPtr<ID3D11Texture2D> output;
  check(device->CreateTexture2D(&outputDesc, nullptr, output.GetAddressOf()), "nv12_shared_rt_srv_texture_unsupported");
  D3D11_RENDER_TARGET_VIEW_DESC1 viewDesc{}; viewDesc.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
  viewDesc.Format = DXGI_FORMAT_R8_UNORM; viewDesc.Texture2D.MipSlice = 0; viewDesc.Texture2D.PlaneSlice = 0;
  ComPtr<ID3D11RenderTargetView1> yView, uvView;
  check(device3->CreateRenderTargetView1(output.Get(), &viewDesc, yView.GetAddressOf()), "nv12_luma_rtv1_unsupported");
  viewDesc.Format = DXGI_FORMAT_R8G8_UNORM; viewDesc.Texture2D.PlaneSlice = 1;
  check(device3->CreateRenderTargetView1(output.Get(), &viewDesc, uvView.GetAddressOf()), "nv12_chroma_rtv1_unsupported");
  ComPtr<IDXGIKeyedMutex> mutex; check(output.As(&mutex), "nv12_keyed_mutex_unsupported");
  ComPtr<IDXGIResource1> resource; check(output.As(&resource), "nv12_nt_resource_unsupported");
  stage("nv12_shared_plane_views_created");
  auto stagingDesc = outputDesc; stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0; stagingDesc.MiscFlags = 0; stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  check(device->CreateTexture2D(&stagingDesc, nullptr, staging.GetAddressOf()), "synthetic_nv12_staging_unsupported");
  ComPtr<ID3D11VertexShader> vertex; ComPtr<ID3D11PixelShader> luma, chroma;
  check(device->CreateVertexShader(shaders.vertex->GetBufferPointer(), shaders.vertex->GetBufferSize(), nullptr, vertex.GetAddressOf()), "vertex_shader_create_failed");
  check(device->CreatePixelShader(shaders.luma->GetBufferPointer(), shaders.luma->GetBufferSize(), nullptr, luma.GetAddressOf()), "luma_shader_create_failed");
  check(device->CreatePixelShader(shaders.chroma->GetBufferPointer(), shaders.chroma->GetBufferSize(), nullptr, chroma.GetAddressOf()), "chroma_shader_create_failed");
  D3D11_RASTERIZER_DESC rasterDesc{}; rasterDesc.FillMode = D3D11_FILL_SOLID; rasterDesc.CullMode = D3D11_CULL_NONE;
  rasterDesc.DepthClipEnable = TRUE; ComPtr<ID3D11RasterizerState> raster;
  check(device->CreateRasterizerState(&rasterDesc, raster.GetAddressOf()), "raster_state_create_failed");
  require(alive(owner.value), "owner_exited");
  require(mutex->AcquireSync(0, 100) == S_OK, "nv12_initial_mutex_unavailable");
  bool held = true;
  try {
    context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertex.Get(), nullptr, 0); context->RSSetState(raster.Get());
    ID3D11ShaderResourceView* srv = inputView.Get(); context->PSSetShaderResources(0, 1, &srv);
    const auto draw = [&](ID3D11RenderTargetView* target, ID3D11PixelShader* shader, UINT width, UINT height) {
      const D3D11_VIEWPORT viewport{0,0,float(width),float(height),0,1};
      context->RSSetViewports(1, &viewport); context->OMSetRenderTargets(1, &target, nullptr);
      context->PSSetShader(shader, nullptr, 0); context->Draw(3, 0);
    };
    draw(yView.Get(), luma.Get(), kWidth, kHeight);
    draw(uvView.Get(), chroma.Get(), kWidth / 2, kHeight / 2);
    context->OMSetRenderTargets(0, nullptr, nullptr); srv = nullptr; context->PSSetShaderResources(0, 1, &srv);
    // All accesses to the shared output, including this tiny test-only copy,
    // are submitted while its mutex is held. No handle or consumer exists yet.
    context->CopyResource(staging.Get(), output.Get()); stage("shader_draws_and_test_copy_submitted");
    if (options.releaseBeforeQuery) {
      check(mutex->ReleaseSync(0), "nv12_initial_mutex_release_failed"); held = false;
      stage("mutex_released_before_query");
    }
    gpuComplete(device.Get(), context.Get(), owner.value); stage("producer_gpu_complete");
    if (held) { check(mutex->ReleaseSync(0), "nv12_initial_mutex_release_failed"); held = false; }
  } catch (...) { if (held) mutex->ReleaseSync(0); throw; }
  const auto validation = validate(context.Get(), staging.Get()); stage("synthetic_rec709_pixels_validated");
  require(alive(owner.value), "owner_exited");
  std::cout << "{\"type\":\"validation\",\"probe\":\"" << kProbe << "\",\"width\":64,\"height\":64,"
    << "\"pattern\":\"quadrants-gray-color-bars-checker-v2\",\"ySamples\":4096,\"uvSamples\":2048,"
    << "\"yMaxError\":" << validation.yMaxError << ",\"uvMaxError\":" << validation.uvMaxError
    << ",\"syncMode\":\"" << (options.releaseBeforeQuery ? "released-query" : "held-query")
    << "\",\"options4Known\":" << (options4Known ? "true" : "false")
    << ",\"extendedNv12Shared\":" << (options4.ExtendedNV12SharedTextureSupported ? "true" : "false")
    << ",\"nv12FormatSupport\":" << nv12Support << ",\"r8FormatSupport\":" << r8Support
    << ",\"rg8FormatSupport\":" << rg8Support << ",\"gpuExecuted\":true,\"electronInteropVerified\":false}" << std::endl;
  if (options.producerOnly) {
    std::cout << "{\"type\":\"done\",\"probe\":\"" << kProbe
      << "\",\"producerOnly\":true,\"nativeValidationPassed\":true,\"exportedHandles\":0}" << std::endl;
    return;
  }
  Handle shared;
  check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
    nullptr, &shared.value), "nv12_nt_shared_handle_unsupported");
  std::cout << "{\"type\":\"ready\",\"probe\":\"" << kProbe << "\",\"protocol\":2,\"width\":64,\"height\":64,"
    << "\"sourceWidth\":64,\"sourceHeight\":64,\"poolSize\":1,\"pixelFormat\":\"nv12\","
    << "\"pattern\":\"quadrants-gray-color-bars-checker-v2\",\"colorSpace\":{\"primaries\":\"bt709\",\"transfer\":\"bt709\","
    << "\"matrix\":\"bt709\",\"range\":\"limited\"}}" << std::endl;
  // This owner-only protocol field must never be persisted as diagnostics.
  std::cout << "{\"type\":\"frame\",\"probe\":\"" << kProbe << "\",\"slot\":0,\"serial\":1,\"handle\":\"0x"
    << std::hex << uintptr_t(shared.value) << std::dec
    << "\",\"timestamp\":1000,\"width\":64,\"height\":64,\"pixelFormat\":\"nv12\",\"refresh\":false,\"producerGpuComplete\":true}" << std::endl;
  require(bool(std::cout), "owner_output_closed");
  const ULONGLONG deadline = GetTickCount64() + 20000; bool imported = false, released = false;
  while (!released) {
    const auto line = command(owner.value, deadline);
    if (line == "stop") break;
    if (line == "imported 0 1") { require(!imported, "duplicate_import_ack"); imported = true; }
    else if (line == "released 0 1") { require(imported, "release_before_import_ack"); released = true; }
    else throw Failure("invalid_owner_command");
  }
  std::cout << "{\"type\":\"done\",\"probe\":\"" << kProbe << "\",\"frames\":1,\"allReferencesReleased\":"
    << (released ? "true" : "false") << "}" << std::endl;
}
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--self-test") selfTest();
    else probe(parseOptions(argc, argv));
    return 0;
  } catch (const Failure& error) {
    std::cout << "{\"type\":\"error\",\"probe\":\"" << kProbe << "\",\"code\":\"" << error.what()
      << "\",\"hresult\":" << int32_t(lastHr) << ",\"deviceRemovedReason\":" << int32_t(removedReason) << "}" << std::endl;
    return 2;
  } catch (...) {
    std::cout << "{\"type\":\"error\",\"probe\":\"" << kProbe << "\",\"code\":\"internal_failure\"}" << std::endl;
    return 2;
  }
}
