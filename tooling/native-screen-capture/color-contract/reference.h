#pragma once
// Independent limited-range Y'CbCr oracle for synthetic tests. Production HLSL
// does not include this header. Fixed 8-bit flat-color expectations below are
// checked independently by the CPU test and consumed directly by the GPU test.
#include <array>
#include <cstdint>

namespace color_contract {
enum class Matrix { Bt601, Bt709 };
using Yuv = std::array<unsigned, 3>;
struct RationalCode {
  int64_t numerator, denominator;
  double value() const { return double(numerator) / double(denominator); }
  bool acceptsUnorm(unsigned actual) const {
    // D3D11.3 3.2.3.6 allows 0.6 ULP after scaling to integer code values.
    // Compare exact rationals: this does not permit a whole-byte tolerance.
    const int64_t error = int64_t(actual) * denominator - numerator;
    return actual <= 255 && (error < 0 ? -error : error) * 5 <= denominator * 3;
  }
};
struct FlatColor {
  const char* name;
  std::array<unsigned char, 3> rgb;
  Yuv bt601, bt709;
};
inline constexpr std::array<FlatColor, 8> kFlatColors{{
  {"black",   {{0,0,0}},       {{16,128,128}},  {{16,128,128}}},
  {"white",   {{255,255,255}}, {{235,128,128}}, {{235,128,128}}},
  {"red",     {{255,0,0}},     {{81,90,240}},   {{63,102,240}}},
  {"green",   {{0,255,0}},     {{145,54,34}},   {{173,42,26}}},
  {"blue",    {{0,0,255}},     {{41,240,110}},  {{32,240,118}}},
  {"cyan",    {{0,255,255}},   {{170,166,16}},  {{188,154,16}}},
  {"magenta", {{255,0,255}},   {{106,202,222}}, {{78,214,230}}},
  {"yellow",  {{255,255,0}},   {{210,16,146}},  {{219,16,138}}}
}};
inline const Yuv& expected(const FlatColor& color, Matrix matrix) {
  return matrix == Matrix::Bt601 ? color.bt601 : color.bt709;
}
// Exact rational Kr/Kb (601:299/1000,114/1000; 709:2126/10000,722/10000).
// Scale Y' to 16..235 and Cb/Cr to 16..240, then round each complete positive
// code value once. Integer arithmetic avoids copying HLSL's float evaluation.
inline std::array<RationalCode, 3> rationalReference(std::array<unsigned char, 3> rgb, Matrix matrix) {
  const int64_t scale = matrix == Matrix::Bt601 ? 1000 : 10000;
  const int64_t kr = matrix == Matrix::Bt601 ? 299 : 2126;
  const int64_t kb = matrix == Matrix::Bt601 ? 114 : 722;
  const int64_t luma = kr * rgb[0] + (scale - kr - kb) * rgb[1] + kb * rgb[2];
  const int64_t yDenominator = scale * 255;
  const int64_t uDenominator = (scale - kb) * 255;
  const int64_t vDenominator = (scale - kr) * 255;
  return {{{16 * yDenominator + 219 * luma, yDenominator},
    {128 * uDenominator + 112 * (scale * rgb[2] - luma), uDenominator},
    {128 * vDenominator + 112 * (scale * rgb[0] - luma), vDenominator}}};
}
inline Yuv limitedReference(std::array<unsigned char, 3> rgb, Matrix matrix) {
  const auto exact = rationalReference(rgb, matrix);
  Yuv rounded{};
  for (unsigned channel = 0; channel < 3; ++channel)
    rounded[channel] = unsigned((exact[channel].numerator + exact[channel].denominator / 2) / exact[channel].denominator);
  return rounded;
}
} // namespace color_contract
