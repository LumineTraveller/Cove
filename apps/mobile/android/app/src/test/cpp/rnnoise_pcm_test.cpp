#include "rnnoise_pcm_processor.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <vector>

static void require(bool condition, const char* description) {
  if (!condition) { std::cerr << description << '\n'; std::exit(1); }
}
static std::vector<std::int16_t> run(RnnoisePcmProcessor& processor,
    const std::vector<std::int16_t>& original, const std::vector<std::size_t>& chunks) {
  auto samples = original;
  std::size_t offset = 0, chunk = 0;
  while (offset < samples.size()) {
    const auto count = std::min(chunks[chunk++ % chunks.size()], samples.size() - offset);
    require(processor.process(samples.data() + offset, count), "processing failed");
    offset += count;
  }
  return samples;
}
int main() {
  std::vector<std::int16_t> input(48'000 + 960);
  for (std::size_t i = 0; i < 48'000; ++i) {
    input[i] = static_cast<std::int16_t>(12'000 * std::sin(i * 0.043) + 6'000 * std::sin(i * 0.071));
  }
  RnnoisePcmProcessor aligned, fragmented;
  require(aligned.reset() && fragmented.reset(), "model initialization failed");
  const auto expected = run(aligned, input, {480});
  const auto actual = run(fragmented, input, {1, 37, 511, 97, 960, 13});
  require(expected == actual, "partial callbacks changed the audio waveform");
  require(std::all_of(actual.begin(), actual.begin() + 480, [](auto value) { return value == 0; }),
      "startup FIFO leaked raw samples");
  require(std::any_of(actual.begin() + 960, actual.end(), [](auto value) { return value != 0; }),
      "model returned only silence");
  require(fragmented.reset(), "model reset failed");
  require(run(fragmented, input, {79, 1920, 3}) == expected, "reset retained previous audio/model state");
  fragmented.release();
  std::int16_t sample = 123;
  require(!fragmented.process(&sample, 1) && sample == 123, "released model modified audio");
  require(fragmented.reset(), "session restart failed");
  std::vector<std::int16_t> silence(4800);
  const auto quiet = run(fragmented, silence, {31, 480, 799});
  require(std::all_of(quiet.begin(), quiet.end(), [](auto value) { return value == 0; }), "reset leaked prior voice into silence");
  require(!fragmented.process(nullptr, 480), "null buffer accepted");
  std::cout << "RNNoise streaming/reset/silence checks passed\n";
}
