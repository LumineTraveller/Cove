cmake_minimum_required(VERSION 3.22)
project(cove_rnnoise_tests LANGUAGES C CXX)
enable_testing()
set(CAPTURE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../main/cpp")
set(RNNOISE_DIR "${CAPTURE_DIR}/third_party/rnnoise-master")
add_executable(rnnoise_pcm_test
  rnnoise_pcm_test.cpp
  "${CAPTURE_DIR}/rnnoise_pcm_processor.cpp"
  "${RNNOISE_DIR}/src/denoise.c"
  "${RNNOISE_DIR}/src/kiss_fft.c"
  "${RNNOISE_DIR}/src/pitch.c"
  "${RNNOISE_DIR}/src/celt_lpc.c"
  "${RNNOISE_DIR}/src/rnn.c"
  "${RNNOISE_DIR}/src/rnn_data.c"
  "${RNNOISE_DIR}/src/rnn_reader.c"
)
target_include_directories(rnnoise_pcm_test PRIVATE "${CAPTURE_DIR}" "${RNNOISE_DIR}/include" "${RNNOISE_DIR}/src")
target_compile_features(rnnoise_pcm_test PRIVATE cxx_std_17)
add_test(NAME rnnoise_pcm_streaming COMMAND rnnoise_pcm_test)
