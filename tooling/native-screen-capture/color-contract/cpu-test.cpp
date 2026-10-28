// Portable CPU-only oracle checks. No Windows/D3D dependency or device access.
#include "reference.h"
#include <iostream>

int main() {
  unsigned checks = 0;
  for (const auto matrix : {color_contract::Matrix::Bt601, color_contract::Matrix::Bt709}) {
    for (const auto& color : color_contract::kFlatColors) {
      const auto actual = color_contract::limitedReference(color.rgb, matrix);
      if (actual != color_contract::expected(color, matrix)) {
        std::cerr << "Flat-color oracle mismatch: " << color.name << '\n';
        return 1;
      }
      checks += 3;
      const auto exact = color_contract::rationalReference(color.rgb, matrix);
      for (unsigned channel = 0; channel < 3; ++channel) {
        if (!exact[channel].acceptsUnorm(actual[channel])) return 1;
        ++checks;
      }
    }
    // Every neutral input must remain neutral chroma, including endpoints.
    for (unsigned gray = 0; gray < 256; ++gray) {
      const auto value = static_cast<unsigned char>(gray);
      const auto actual = color_contract::limitedReference({{value,value,value}}, matrix);
      if (actual[1] != 128 || actual[2] != 128 || actual[0] < 16 || actual[0] > 235) return 1;
      ++checks;
    }
  }
  // These strongly separated values make a mistaken matrix detectable; this
  // test never treats a larger tolerance as a replacement for matrix selection.
  const auto red601 = color_contract::kFlatColors[2].bt601;
  const auto red709 = color_contract::kFlatColors[2].bt709;
  if (red601 == red709) return 1;
  ++checks;
  // Exact 0.6 boundary and a 0.99 error: a blanket integer tolerance 1 would
  // wrongly accept the latter. Check both sides without floating arithmetic.
  for (const auto test : {std::array<int64_t,4>{{10060,100,100,1}}, {{10061,100,100,0}},
      {{10099,100,100,0}}, {{10040,100,101,1}}, {{10039,100,101,0}}}) {
    const color_contract::RationalCode exact{test[0], test[1]};
    if (exact.acceptsUnorm(unsigned(test[2])) != bool(test[3])) return 1;
    ++checks;
  }
  // The reported green 144 is legal only under continuous UNORM precision;
  // mathematical round-to-nearest remains 145. Neighbor 143 is not legal.
  const auto green601 = color_contract::rationalReference(color_contract::kFlatColors[3].rgb, color_contract::Matrix::Bt601);
  if (!green601[0].acceptsUnorm(144) || !green601[0].acceptsUnorm(145) || green601[0].acceptsUnorm(143)) return 1;
  checks += 3;
  for (const auto& color : color_contract::kFlatColors) {
    if (color.rgb == color_contract::kFlatColors[0].rgb || color.rgb == color_contract::kFlatColors[1].rgb) continue;
    for (const auto matrix : {color_contract::Matrix::Bt601, color_contract::Matrix::Bt709}) {
      const auto exact = color_contract::rationalReference(color.rgb, matrix);
      const auto& wrong = color_contract::expected(color, matrix == color_contract::Matrix::Bt601 ?
        color_contract::Matrix::Bt709 : color_contract::Matrix::Bt601);
      bool accepted = true;
      for (unsigned channel = 0; channel < 3; ++channel) accepted = accepted && exact[channel].acceptsUnorm(wrong[channel]);
      if (accepted) return 1;
      ++checks;
    }
  }
  std::cout << "{\"type\":\"color-contract-cpu\",\"passed\":true,\"cpuOnly\":true,\"checks\":"
    << checks << "}\n";
  return 0;
}
