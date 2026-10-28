// Synthetic diagnosis only. Keeps the strict zero-error GPU test unchanged.
// Reads the exact production BGRA scratch, production NV12 planes, and the same
// production NV12 pixel shaders rendered to FLOAT targets before UNORM storage.
#define main native_helper_main_unused
#include "../../../apps/desktop/electron/native-screen-capture-helper.cpp"
#undef main
#include "reference.h"
#include <iomanip>
#ifndef COVE_COLOR_STANDARD_ORACLE
#define COVE_COLOR_STANDARD_ORACLE 0
#endif

struct DiagnosticSurface {
  ComPtr<ID3D11Texture2D> texture, staging;
  ComPtr<ID3D11RenderTargetView> target;
};
static DiagnosticSurface diagnosticSurface(ID3D11Device* device, UINT width, UINT height, DXGI_FORMAT format,
    bool renderTarget) {
  DiagnosticSurface result;
  auto desc = textureDesc(width, height, format, renderTarget ? D3D11_BIND_RENDER_TARGET : 0);
  check(device->CreateTexture2D(&desc, nullptr, result.texture.GetAddressOf()), "diagnostic_texture_failed");
  if (renderTarget) check(device->CreateRenderTargetView(result.texture.Get(), nullptr,
    result.target.GetAddressOf()), "diagnostic_target_failed");
  desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  check(device->CreateTexture2D(&desc, nullptr, result.staging.GetAddressOf()), "diagnostic_staging_failed");
  return result;
}
static void completeDiagnostic(ID3D11Device* device, ID3D11DeviceContext* context) {
  ComPtr<ID3D11Query> query;
  const D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT, 0};
  check(device->CreateQuery(&desc, query.GetAddressOf()), "diagnostic_query_failed");
  context->End(query.Get()); context->Flush();
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT result = context->GetData(query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) break;
    require(result == S_FALSE && GetTickCount64() < deadline, "diagnostic_completion_failed"); Sleep(1);
  }
  check(device->GetDeviceRemovedReason(), "diagnostic_device_lost");
}
static D3D11_MAPPED_SUBRESOURCE mapDiagnostic(ID3D11DeviceContext* context, ID3D11Texture2D* texture) {
  D3D11_MAPPED_SUBRESOURCE mapped{};
  const ULONGLONG deadline = GetTickCount64() + 3000;
  while (true) {
    const HRESULT result = context->Map(texture, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    if (result == S_OK) return mapped;
    require(result == DXGI_ERROR_WAS_STILL_DRAWING && GetTickCount64() < deadline, "diagnostic_map_failed"); Sleep(1);
  }
}
template<class Value> static std::vector<Value> readDiagnostic(ID3D11DeviceContext* context,
    ID3D11Texture2D* staging, UINT width, UINT height, UINT components = 4) {
  std::vector<Value> result(size_t(width) * height * components);
  const auto mapped = mapDiagnostic(context, staging);
  const size_t rowBytes = size_t(width) * components * sizeof(Value);
  if (!mapped.pData || mapped.RowPitch < rowBytes) { context->Unmap(staging, 0); throw Failure("diagnostic_pitch_failed"); }
  for (UINT y = 0; y < height; ++y) std::memcpy(result.data() + size_t(y) * width * components,
    static_cast<const unsigned char*>(mapped.pData) + size_t(y) * mapped.RowPitch, rowBytes);
  context->Unmap(staging, 0);
  return result;
}
static void drawFloatDiagnostic(ID3D11Device* device, ID3D11DeviceContext* context,
    Pipeline& pipeline, DiagnosticSurface& surface, UINT width, UINT height, const char* entry,
    Nv12ColorSpace colorSpace) {
  ComPtr<ID3D11ShaderResourceView> view;
  check(device->CreateShaderResourceView(pipeline.nv12Scratch(), nullptr, view.GetAddressOf()), "diagnostic_source_view_failed");
  const auto code = compile(entry, "ps_4_0", colorSpace);
  ComPtr<ID3D11PixelShader> shader;
  check(device->CreatePixelShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr,
    shader.GetAddressOf()), "diagnostic_shader_failed");
  ID3D11ShaderResourceView* source = view.Get();
  ID3D11RenderTargetView* target = surface.target.Get();
  const D3D11_VIEWPORT viewport{0, 0, FLOAT(width), FLOAT(height), 0, 1};
  context->RSSetViewports(1, &viewport); context->PSSetShaderResources(0, 1, &source);
  context->OMSetRenderTargets(1, &target, nullptr); context->PSSetShader(shader.Get(), nullptr, 0); context->Draw(3, 0);
  source = nullptr; context->PSSetShaderResources(0, 1, &source); context->OMSetRenderTargets(0, nullptr, nullptr);
}
struct ByteRange {
  unsigned minimum = 255, maximum = 0, samples = 0, mismatches = 0, maxAbsError = 0;
  int minSignedError = 255, maxSignedError = -255;
  void add(unsigned actual, unsigned expected) {
    const int error = int(actual) - int(expected);
    minimum = std::min(minimum, actual); maximum = std::max(maximum, actual); ++samples;
    mismatches += actual != expected; maxAbsError = std::max(maxAbsError, unsigned(std::abs(error)));
    minSignedError = std::min(minSignedError, error); maxSignedError = std::max(maxSignedError, error);
  }
};
struct FloatRange {
  double minimum = std::numeric_limits<double>::infinity(), maximum = -std::numeric_limits<double>::infinity();
  double maxReferenceError = 0, maxQuantizationError = 0;
  bool withinUnorm06 = true;
  void add(float normalized, unsigned actual, double reference) {
    require(std::isfinite(normalized), "diagnostic_nonfinite_shader_output");
    const double code = double(normalized) * 255;
    minimum = std::min(minimum, code); maximum = std::max(maximum, code);
    maxReferenceError = std::max(maxReferenceError, std::abs(code - reference));
    const double error = std::abs(double(actual) - code);
    maxQuantizationError = std::max(maxQuantizationError, error);
    // D3D11.3 3.2.3.6 permits 0.6 ULP on integer-side float-to-UNORM.
    // This diagnostic records that separate boundary; strict golden remains 0.
    withinUnorm06 = withinUnorm06 && error <= .60001;
  }
};
struct ColorDiagnostic {
  std::array<ByteRange, 4> bgra;
  std::array<ByteRange, 3> nv12;
  std::array<FloatRange, 3> floatCode;
  std::array<ByteRange, 3> plainUnorm;
  std::array<FloatRange, 3> plainFloatCode;
  std::array<unsigned, 3> rationalQuantizationFailures{};
};
struct DiagnosticResult { unsigned strictFailures = 0, standardFailures = 0; };
static void printRange(const ByteRange& range) {
  std::cout << "{\"minimum\":" << range.minimum << ",\"maximum\":" << range.maximum
    << ",\"samples\":" << range.samples << ",\"mismatches\":" << range.mismatches
    << ",\"maxAbsError\":" << range.maxAbsError << ",\"signedErrorMinimum\":" << range.minSignedError
    << ",\"signedErrorMaximum\":" << range.maxSignedError << '}';
}
static DiagnosticResult runDiagnostic(ID3D11Device* device, ID3D11DeviceContext* context,
    Nv12ColorSpace colorSpace, Size source) {
  const Size target{16,4};
  const auto matrix = colorSpace == Nv12ColorSpace::Bt601Limited ? color_contract::Matrix::Bt601 : color_contract::Matrix::Bt709;
  Pipeline pipeline(device, source, target, true, colorSpace);
  Slot slot; createSlot(device, slot, target, true, true);
  auto bgra = diagnosticSurface(device, target.width, target.height, DXGI_FORMAT_B8G8R8A8_UNORM, false);
  auto floatY = diagnosticSurface(device, target.width, target.height, DXGI_FORMAT_R32G32B32A32_FLOAT, true);
  auto floatUv = diagnosticSurface(device, target.width / 2, target.height / 2, DXGI_FORMAT_R32G32B32A32_FLOAT, true);
  auto plainY = diagnosticSurface(device, target.width, target.height, DXGI_FORMAT_R8_UNORM, true);
  auto plainUv = diagnosticSurface(device, target.width / 2, target.height / 2, DXGI_FORMAT_R8G8_UNORM, true);
  std::vector<unsigned char> sourceBytes(size_t(source.width) * source.height * 4);
  for (UINT y = 0; y < source.height; ++y) for (UINT x = 0; x < source.width; ++x) {
    const auto& color = color_contract::kFlatColors[x * 8 / source.width];
    const size_t offset = (size_t(y) * source.width + x) * 4;
    sourceBytes[offset] = color.rgb[2]; sourceBytes[offset + 1] = color.rgb[1];
    sourceBytes[offset + 2] = color.rgb[0]; sourceBytes[offset + 3] = 255;
  }
  context->UpdateSubresource(pipeline.desktop.Get(), 0, nullptr, sourceBytes.data(), source.width * 4, 0);
  pipeline.drawNv12(context, slot.target.Get(), slot.chromaTarget.Get());
  context->CopyResource(slot.staging.Get(), slot.texture.Get());
  context->CopyResource(bgra.staging.Get(), pipeline.nv12Scratch());
  drawFloatDiagnostic(device, context, pipeline, floatY, target.width, target.height, "nv12LumaMain", colorSpace);
  drawFloatDiagnostic(device, context, pipeline, floatUv, target.width / 2, target.height / 2, "nv12ChromaMain", colorSpace);
  drawFloatDiagnostic(device, context, pipeline, plainY, target.width, target.height, "nv12LumaMain", colorSpace);
  drawFloatDiagnostic(device, context, pipeline, plainUv, target.width / 2, target.height / 2, "nv12ChromaMain", colorSpace);
  context->CopyResource(floatY.staging.Get(), floatY.texture.Get()); context->CopyResource(floatUv.staging.Get(), floatUv.texture.Get());
  context->CopyResource(plainY.staging.Get(), plainY.texture.Get()); context->CopyResource(plainUv.staging.Get(), plainUv.texture.Get());
  completeDiagnostic(device, context);
  const auto mapped = mapDiagnostic(context, slot.staging.Get());
  try { copyNv12Rows(mapped, target, slot.cpuView.value, slot.cpuView.byteLength); }
  catch (...) { context->Unmap(slot.staging.Get(), 0); throw; }
  context->Unmap(slot.staging.Get(), 0);
  const auto rgbBytes = readDiagnostic<unsigned char>(context, bgra.staging.Get(), target.width, target.height);
  const auto shaderY = readDiagnostic<float>(context, floatY.staging.Get(), target.width, target.height);
  const auto shaderUv = readDiagnostic<float>(context, floatUv.staging.Get(), target.width / 2, target.height / 2);
  const auto genericY = readDiagnostic<unsigned char>(context, plainY.staging.Get(), target.width, target.height, 1);
  const auto genericUv = readDiagnostic<unsigned char>(context, plainUv.staging.Get(), target.width / 2, target.height / 2, 2);
  std::array<ColorDiagnostic, 8> colors{};
  for (UINT y = 0; y < target.height; ++y) for (UINT x = 0; x < target.width; ++x) {
    const size_t colorIndex = x / 2, pixel = size_t(y) * target.width + x;
    const auto& color = color_contract::kFlatColors[colorIndex]; auto& observed = colors[colorIndex];
    const auto& golden = color_contract::expected(color, matrix); const auto exact = color_contract::rationalReference(color.rgb, matrix);
    const std::array<unsigned, 4> expectedBgra{{color.rgb[2], color.rgb[1], color.rgb[0], 255}};
    for (unsigned channel = 0; channel < 4; ++channel) observed.bgra[channel].add(rgbBytes[pixel * 4 + channel], expectedBgra[channel]);
    const unsigned actual = slot.cpuView.value[pixel]; observed.nv12[0].add(actual, golden[0]);
    observed.floatCode[0].add(shaderY[pixel * 4], actual, exact[0].value());
    observed.rationalQuantizationFailures[0] += !exact[0].acceptsUnorm(actual);
    observed.plainUnorm[0].add(genericY[pixel], golden[0]);
    observed.plainFloatCode[0].add(shaderY[pixel * 4], genericY[pixel], exact[0].value());
  }
  const size_t uvOffset = size_t(target.width) * target.height;
  for (UINT y = 0; y < target.height / 2; ++y) for (UINT x = 0; x < target.width; x += 2) {
    const size_t colorIndex = x / 2, pixel = size_t(y) * target.width / 2 + x / 2;
    const auto& color = color_contract::kFlatColors[colorIndex]; auto& observed = colors[colorIndex];
    const auto& golden = color_contract::expected(color, matrix); const auto exact = color_contract::rationalReference(color.rgb, matrix);
    for (unsigned channel = 0; channel < 2; ++channel) {
      const unsigned actual = slot.cpuView.value[uvOffset + size_t(y) * target.width + x + channel];
      observed.nv12[channel + 1].add(actual, golden[channel + 1]);
      observed.floatCode[channel + 1].add(shaderUv[pixel * 4 + channel], actual, exact[channel + 1].value());
      observed.rationalQuantizationFailures[channel + 1] += !exact[channel + 1].acceptsUnorm(actual);
      observed.plainUnorm[channel + 1].add(genericUv[pixel * 2 + channel], golden[channel + 1]);
      observed.plainFloatCode[channel + 1].add(shaderUv[pixel * 4 + channel], genericUv[pixel * 2 + channel], exact[channel + 1].value());
    }
  }
  unsigned mismatches = 0, bgraMismatches = 0, quantizationFailures = 0, shaderFailures = 0;
  double shaderError = 0, quantizationError = 0; bool within06 = true;
  for (size_t index = 0; index < colors.size(); ++index) {
    const auto& color = color_contract::kFlatColors[index]; const auto& observed = colors[index];
    const auto& golden = color_contract::expected(color, matrix); const auto exact = color_contract::rationalReference(color.rgb, matrix);
    std::cout << "{\"type\":\"color-contract-diagnostic-color\",\"syntheticOnly\":true,\"colorSpace\":\""
      << nv12ColorSpaceName(colorSpace) << "\",\"sourceWidth\":" << source.width << ",\"sourceHeight\":" << source.height
      << ",\"targetWidth\":16,\"targetHeight\":4,\"color\":\"" << color.name << "\",\"inputRgb\":["
      << unsigned(color.rgb[0]) << ',' << unsigned(color.rgb[1]) << ',' << unsigned(color.rgb[2]) << "],\"scratchBgra\":[";
    for (unsigned channel = 0; channel < 4; ++channel) { if (channel) std::cout << ','; printRange(observed.bgra[channel]); bgraMismatches += observed.bgra[channel].mismatches; }
    std::cout << "],\"planes\":[";
    for (unsigned channel = 0; channel < 3; ++channel) {
      if (channel) std::cout << ',';
      const auto& floats = observed.floatCode[channel]; mismatches += observed.nv12[channel].mismatches;
      quantizationFailures += observed.rationalQuantizationFailures[channel];
      shaderFailures += floats.maxReferenceError > .001;
      shaderError = std::max(shaderError, floats.maxReferenceError); quantizationError = std::max(quantizationError, floats.maxQuantizationError);
      within06 = within06 && floats.withinUnorm06;
      std::cout << "{\"plane\":\"" << "YUV"[channel] << "\",\"golden\":" << golden[channel]
        << ",\"rationalNumerator\":" << exact[channel].numerator << ",\"rationalDenominator\":" << exact[channel].denominator
        << ",\"rationalValue\":" << exact[channel].value() << ",\"actual\":"; printRange(observed.nv12[channel]);
      std::cout << ",\"floatShaderCodeMinimum\":" << floats.minimum << ",\"floatShaderCodeMaximum\":" << floats.maximum
        << ",\"floatShaderVsRationalMaxAbsError\":" << floats.maxReferenceError
        << ",\"unormVsFloatMaxAbsError\":" << floats.maxQuantizationError
        << ",\"withinUnorm06Ulp\":" << (floats.withinUnorm06 ? "true" : "false")
        << ",\"rationalQuantizationFailures\":" << observed.rationalQuantizationFailures[channel]
        << ",\"plainUnormActual\":"; printRange(observed.plainUnorm[channel]);
      std::cout << ",\"plainUnormVsFloatMaxAbsError\":" << observed.plainFloatCode[channel].maxQuantizationError << '}';
    }
    std::cout << "]}\n";
  }
  const DiagnosticResult outcome{mismatches + bgraMismatches + shaderFailures + unsigned(!within06),
    bgraMismatches + shaderFailures + quantizationFailures};
  std::cout << "{\"type\":\"color-contract-diagnostic-case\",\"colorSpace\":\"" << nv12ColorSpaceName(colorSpace)
    << "\",\"sourceWidth\":" << source.width << ",\"sourceHeight\":" << source.height
    << ",\"scratchMismatches\":" << bgraMismatches << ",\"strictGoldenMismatches\":" << mismatches
    << ",\"rationalQuantizationFailures\":" << quantizationFailures << ",\"floatShaderFailures\":" << shaderFailures
    << ",\"floatShaderVsRationalMaxAbsError\":" << shaderError << ",\"unormVsFloatMaxAbsError\":" << quantizationError
    << ",\"withinUnorm06Ulp\":" << (within06 ? "true" : "false") << ",\"strictPassed\":" << (outcome.strictFailures ? "false" : "true")
    << ",\"strictFailureCount\":" << outcome.strictFailures
    << ",\"standardOraclePassed\":" << (outcome.standardFailures ? "false" : "true")
    << ",\"standardFailureCount\":" << outcome.standardFailures << "}\n";
  return outcome;
}
int main(int argc, char** argv) {
  try {
    require(argc == 1 || (argc == 3 && std::string(argv[1]) == "--color-space"), "invalid_arguments");
    const std::string selection = argc == 1 ? "both" : argv[2];
    require(selection == "both" || selection == "bt601-limited" || selection == "bt709-limited", "invalid_arguments");
    std::cout << std::setprecision(12);
    ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_0};
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, 1, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "diagnostic_hardware_unavailable");
    DiagnosticResult totals;
    for (const auto matrix : {Nv12ColorSpace::Bt601Limited, Nv12ColorSpace::Bt709Limited}) {
      if (selection != "both" && selection != nv12ColorSpaceName(matrix)) continue;
      for (const Size source : {Size{16,4}, Size{32,8}}) {
        const auto result = runDiagnostic(device.Get(), context.Get(), matrix, source);
        totals.strictFailures += result.strictFailures; totals.standardFailures += result.standardFailures;
      }
    }
    std::cout << "{\"type\":\"color-contract-diagnostic\",\"syntheticOnly\":true,\"strictPassed\":"
      << (totals.strictFailures ? "false" : "true") << ",\"strictFailureCount\":" << totals.strictFailures
      << ",\"standardOraclePassed\":" << (totals.standardFailures ? "false" : "true")
      << ",\"standardFailureCount\":" << totals.standardFailures << "}\n";
#if COVE_COLOR_STANDARD_ORACLE
    return totals.standardFailures ? 2 : 0;
#else
    return totals.strictFailures ? 2 : 0;
#endif
  } catch (const Failure& error) { std::cout << "{\"type\":\"error\",\"code\":\"" << error.what() << "\"}\n"; return 2; }
  catch (...) { std::cout << "{\"type\":\"error\",\"code\":\"internal_failure\"}\n"; return 2; }
}
