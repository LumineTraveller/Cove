// Isolated feasibility probe: one synthetic BGRA -> NV12 GPU conversion.
// No desktop API, encoder, network, full-frame readback or product provider.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>

using Microsoft::WRL::ComPtr;
constexpr UINT kWidth = 64, kHeight = 64;
constexpr const char* kProbe = "nv12-video-processor";
class Failure final : public std::exception {
  const char* code_;
public:
  explicit Failure(const char* code) : code_(code) {}
  const char* what() const noexcept override { return code_; }
};
static void require(bool condition, const char* code) { if (!condition) throw Failure(code); }
static void check(HRESULT value, const char* code) { require(SUCCEEDED(value), code); }
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(const Handle&) = delete;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
static DWORD parentPid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.value != INVALID_HANDLE_VALUE, "owner_snapshot_failed");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.value, &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.value, &entry));
  throw Failure("owner_not_found");
}
static DWORD ownerArgument(int argc, char** argv) {
  require(argc == 3 && std::string(argv[1]) == "--owner-pid", "invalid_arguments");
  const std::string text(argv[2]); require(!text.empty() && text.size() <= 10, "invalid_owner_pid");
  uint64_t value = 0;
  for (char digit : text) {
    require(digit >= '0' && digit <= '9', "invalid_owner_pid");
    value = value * 10 + unsigned(digit - '0');
    require(value <= MAXDWORD, "invalid_owner_pid");
  }
  require(value && DWORD(value) == parentPid(), "owner_is_not_parent");
  return DWORD(value);
}
static std::array<unsigned char, 4> sourcePixel(UINT x, UINT y) {
  // Returned byte order BGRA. All boundaries are even for NV12 4:2:0.
  static constexpr unsigned char grays[]{0,32,64,96,128,160,192,255};
  static constexpr std::array<unsigned char, 4> colors[]{
    {{0,0,255,255}}, {{0,255,0,255}}, {{255,0,0,255}}, {{255,255,255,255}},
    {{0,0,0,255}}, {{255,255,0,255}}, {{255,0,255,255}}, {{0,255,255,255}},
  };
  if (y >= 24 && y < 40) {
    const unsigned char gray = grays[x / 8]; return {gray,gray,gray,255};
  }
  if (y >= 44 && y < 52) return colors[x / 8];
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
static void selfTest() {
  require(sourcePixel(8,8) == std::array<unsigned char,4>{0,0,255,255} &&
    sourcePixel(56,8) == std::array<unsigned char,4>{0,255,0,255} &&
    sourcePixel(8,56) == std::array<unsigned char,4>{255,0,0,255} &&
    sourcePixel(56,56) == std::array<unsigned char,4>{255,255,255,255}, "pattern_corner_self_test_failed");
  auto pixels = sourcePixels();
  for (size_t index = 3; index < pixels.size(); index += 4) require(pixels[index] == 255, "pattern_alpha_self_test_failed");
  for (UINT bar = 0; bar < 8; ++bar) {
    const auto gray = sourcePixel(bar * 8 + 4, 32);
    require(gray[0] == gray[1] && gray[1] == gray[2], "pattern_gray_self_test_failed");
  }
  SecureZeroMemory(pixels.data(), pixels.size());
  std::cout << "{\"type\":\"self-test\",\"probe\":\"" << kProbe
    << "\",\"passed\":true,\"cpuOnly\":true}" << std::endl;
}
static bool alive(HANDLE owner) { return WaitForSingleObject(owner, 0) == WAIT_TIMEOUT; }
static std::string command(HANDLE owner, ULONGLONG deadline) {
  std::string line;
  while (GetTickCount64() < deadline) {
    require(alive(owner), "owner_exited");
    DWORD available = 0;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
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
static void gpuComplete(ID3D11Device* device, ID3D11DeviceContext* context, HANDLE owner) {
  D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT, 0}; ComPtr<ID3D11Query> query;
  check(device->CreateQuery(&desc, query.GetAddressOf()), "gpu_query_create_failed");
  context->End(query.Get()); context->Flush();
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT result = context->GetData(query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) break;
    require(result == S_FALSE, "gpu_completion_failed");
    require(alive(owner), "owner_exited");
    require(GetTickCount64() < deadline, "gpu_completion_timeout");
    Sleep(1);
  }
  check(device->GetDeviceRemovedReason(), "gpu_device_lost");
}
static void probe(DWORD ownerPid) {
  Handle owner(OpenProcess(SYNCHRONIZE, FALSE, ownerPid));
  require(owner.value && alive(owner.value), "owner_unavailable");
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL requested[]{D3D_FEATURE_LEVEL_11_0}; D3D_FEATURE_LEVEL actual{};
  check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, requested, 1,
    D3D11_SDK_VERSION, device.GetAddressOf(), &actual, context.GetAddressOf()), "hardware_video_device_unsupported");
  require(actual >= D3D_FEATURE_LEVEL_11_0, "feature_level_11_required");
  ComPtr<ID3D11VideoDevice> video; check(device.As(&video), "video_device_unsupported");
  ComPtr<ID3D11VideoContext1> videoContext; check(context.As(&videoContext), "video_context1_unsupported");
  D3D11_FEATURE_DATA_D3D11_OPTIONS4 options4{};
  const bool options4Known = SUCCEEDED(device->CheckFeatureSupport(D3D11_FEATURE_D3D11_OPTIONS4, &options4, sizeof(options4)));
  // Options4 concerns extended NV12 sharing; the exact RT|SRV shared descriptor
  // below remains the gate, followed by the separate Electron import test.
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
  content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  content.InputFrameRate = {60,1}; content.OutputFrameRate = {60,1};
  content.InputWidth = content.OutputWidth = kWidth; content.InputHeight = content.OutputHeight = kHeight;
  content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  check(video->CreateVideoProcessorEnumerator(&content, enumerator.GetAddressOf()), "video_processor_enumerator_unsupported");
  UINT inputFlags = 0, outputFlags = 0;
  check(enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &inputFlags), "bgra_vp_format_query_failed");
  check(enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &outputFlags), "nv12_vp_format_query_failed");
  require((inputFlags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) &&
    (outputFlags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT), "bgra_to_nv12_vp_unsupported");
  ComPtr<ID3D11VideoProcessorEnumerator1> enumerator1;
  check(enumerator.As(&enumerator1), "video_processor_enumerator1_unsupported");
  BOOL supported = FALSE;
  check(enumerator1->CheckVideoProcessorFormatConversion(DXGI_FORMAT_B8G8R8A8_UNORM,
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_FORMAT_NV12,
    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, &supported), "vp_color_conversion_query_failed");
  require(supported != FALSE, "vp_full709_to_studio709_unsupported");
  D3D11_VIDEO_PROCESSOR_CAPS caps{}; check(enumerator->GetVideoProcessorCaps(&caps), "video_processor_caps_failed");
  require(caps.MaxInputStreams >= 1 && caps.MaxStreamStates >= 1 && caps.RateConversionCapsCount >= 1,
    "video_processor_stream_unsupported");
  const bool shaderUsageHintSupported = (caps.FeatureCaps & D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_SHADER_USAGE) != 0;
  ComPtr<ID3D11VideoProcessor> processor;
  check(video->CreateVideoProcessor(enumerator.Get(), 0, processor.GetAddressOf()), "video_processor_create_failed");

  D3D11_TEXTURE2D_DESC inputDesc{};
  inputDesc.Width = kWidth; inputDesc.Height = kHeight; inputDesc.MipLevels = 1; inputDesc.ArraySize = 1;
  inputDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; inputDesc.SampleDesc.Count = 1;
  inputDesc.Usage = D3D11_USAGE_DEFAULT; inputDesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  auto pixels = sourcePixels();
  const D3D11_SUBRESOURCE_DATA initial{pixels.data(), kWidth * 4, 0};
  ComPtr<ID3D11Texture2D> input;
  const HRESULT createdInput = device->CreateTexture2D(&inputDesc, &initial, input.GetAddressOf());
  SecureZeroMemory(pixels.data(), pixels.size()); check(createdInput, "synthetic_bgra_texture_failed");
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inputViewDesc{};
  inputViewDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11VideoProcessorInputView> inputView;
  check(video->CreateVideoProcessorInputView(input.Get(), enumerator.Get(), &inputViewDesc,
    inputView.GetAddressOf()), "bgra_video_input_view_unsupported");
  auto outputDesc = inputDesc; outputDesc.Format = DXGI_FORMAT_NV12;
  outputDesc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  ComPtr<ID3D11Texture2D> output;
  check(device->CreateTexture2D(&outputDesc, nullptr, output.GetAddressOf()), "nv12_shared_rt_srv_texture_unsupported");
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outputViewDesc{};
  outputViewDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11VideoProcessorOutputView> outputView;
  check(video->CreateVideoProcessorOutputView(output.Get(), enumerator.Get(), &outputViewDesc,
    outputView.GetAddressOf()), "nv12_video_output_view_unsupported");
  ComPtr<IDXGIKeyedMutex> mutex; check(output.As(&mutex), "nv12_keyed_mutex_unsupported");
  ComPtr<IDXGIResource1> resource; check(output.As(&resource), "nv12_nt_resource_unsupported");

  const RECT full{0,0,LONG(kWidth),LONG(kHeight)};
  videoContext->VideoProcessorSetStreamFrameFormat(processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
  videoContext->VideoProcessorSetStreamAutoProcessingMode(processor.Get(), 0, FALSE);
  videoContext->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE, &full);
  videoContext->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE, &full);
  videoContext->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE, &full);
  videoContext->VideoProcessorSetOutputStereoMode(processor.Get(), FALSE);
  if (shaderUsageHintSupported) videoContext->VideoProcessorSetOutputShaderUsage(processor.Get(), TRUE);
  videoContext->VideoProcessorSetStreamColorSpace1(processor.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
  videoContext->VideoProcessorSetOutputColorSpace1(processor.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  DXGI_COLOR_SPACE_TYPE readInput = DXGI_COLOR_SPACE_CUSTOM, readOutput = DXGI_COLOR_SPACE_CUSTOM;
  videoContext->VideoProcessorGetStreamColorSpace1(processor.Get(), 0, &readInput);
  videoContext->VideoProcessorGetOutputColorSpace1(processor.Get(), &readOutput);
  require(readInput == DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 &&
    readOutput == DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, "vp_color_state_mismatch");
  require(mutex->AcquireSync(0, 100) == S_OK, "nv12_initial_mutex_unavailable");
  try {
    D3D11_VIDEO_PROCESSOR_STREAM stream{}; stream.Enable = TRUE; stream.pInputSurface = inputView.Get();
    check(videoContext->VideoProcessorBlt(processor.Get(), outputView.Get(), 0, 1, &stream), "vp_blt_failed");
    gpuComplete(device.Get(), context.Get(), owner.value);
  } catch (...) { mutex->ReleaseSync(0); throw; }
  check(mutex->ReleaseSync(0), "nv12_initial_mutex_release_failed");
  Handle shared;
  check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
    nullptr, &shared.value), "nv12_nt_shared_handle_unsupported");
  std::cout << "{\"type\":\"ready\",\"probe\":\"" << kProbe << "\",\"protocol\":2,\"width\":64,\"height\":64,"
    << "\"sourceWidth\":64,\"sourceHeight\":64,\"poolSize\":1,\"pixelFormat\":\"nv12\","
    << "\"pattern\":\"quadrants-gray-color-bars-v1\",\"colorSpace\":{\"primaries\":\"bt709\",\"transfer\":\"bt709\","
    << "\"matrix\":\"bt709\",\"range\":\"limited\"},\"options4Known\":" << (options4Known ? "true" : "false")
    << ",\"extendedNv12Shared\":" << (options4.ExtendedNV12SharedTextureSupported ? "true" : "false")
    << ",\"shaderUsageHintSupported\":" << (shaderUsageHintSupported ? "true" : "false") << "}" << std::endl;
  std::cout << "{\"type\":\"frame\",\"probe\":\"" << kProbe << "\",\"slot\":0,\"serial\":1,\"handle\":\"0x"
    << std::hex << uintptr_t(shared.value) << std::dec
    << "\",\"timestamp\":1000,\"width\":64,\"height\":64,\"pixelFormat\":\"nv12\",\"refresh\":false,\"producerGpuComplete\":true}" << std::endl;
  require(bool(std::cout), "owner_output_closed");
  const ULONGLONG deadline = GetTickCount64() + 20000;
  bool imported = false, released = false;
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
    else probe(ownerArgument(argc, argv));
    return 0;
  } catch (const Failure& error) {
    std::cout << "{\"type\":\"error\",\"probe\":\"" << kProbe << "\",\"code\":\"" << error.what() << "\"}" << std::endl;
    return 2;
  } catch (...) {
    std::cout << "{\"type\":\"error\",\"probe\":\"" << kProbe << "\",\"code\":\"internal_failure\"}" << std::endl;
    return 2;
  }
}
