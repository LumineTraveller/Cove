#include "rnnoise_pcm_processor.h"
#include <algorithm>
#include <cmath>

RnnoisePcmProcessor::~RnnoisePcmProcessor() { release(); }
void RnnoisePcmProcessor::release() {
  if (state_) rnnoise_destroy(state_);
  state_ = nullptr;
}
bool RnnoisePcmProcessor::reset() {
  release();
  filled_ = read_ = 0;
  queued_ = kFrame;
  fifo_.fill(0);
  state_ = rnnoise_create(nullptr);
  return state_ != nullptr && rnnoise_get_frame_size() == kFrame;
}
bool RnnoisePcmProcessor::process(std::int16_t* samples, std::size_t count) {
  if (!state_ || !samples) return false;
  for (std::size_t i = 0; i < count; ++i) {
    // RNNoise expects the int16 amplitude scale, not normalized [-1, 1].
    input_[filled_++] = static_cast<float>(samples[i]);
    if (filled_ == kFrame) {
      rnnoise_process_frame(state_, output_.data(), input_.data());
      for (float value : output_) {
        const float clipped = std::isfinite(value) ? std::clamp(value, -32768.f, 32767.f) : 0.f;
        fifo_[(read_ + queued_) % fifo_.size()] = static_cast<std::int16_t>(clipped);
        ++queued_;
      }
      filled_ = 0;
    }
    samples[i] = fifo_[read_];
    read_ = (read_ + 1) % fifo_.size();
    --queued_;
  }
  return true;
}
