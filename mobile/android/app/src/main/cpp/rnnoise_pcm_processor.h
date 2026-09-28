#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include "rnnoise.h"

// Every sample is denoised once, irrespective of callback boundaries. The fixed
// 480-sample FIFO makes partial frames causal: no raw tail or lost prefix.
class RnnoisePcmProcessor {
 public:
  static constexpr std::size_t kFrame = 480;
  RnnoisePcmProcessor() = default;
  ~RnnoisePcmProcessor();
  RnnoisePcmProcessor(const RnnoisePcmProcessor&) = delete;
  RnnoisePcmProcessor& operator=(const RnnoisePcmProcessor&) = delete;
  bool reset();
  void release();
  bool process(std::int16_t* samples, std::size_t count);
 private:
  DenoiseState* state_ = nullptr;
  std::array<float, kFrame> input_{};
  std::array<float, kFrame> output_{};
  std::array<std::int16_t, kFrame * 2> fifo_{};
  std::size_t filled_ = 0;
  std::size_t read_ = 0;
  std::size_t queued_ = kFrame;
};
