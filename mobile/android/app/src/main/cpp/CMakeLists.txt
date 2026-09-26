cmake_minimum_required(VERSION 3.22.1)
project(cove_rnnoise)

set(RNNOISE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/rnnoise-master)

add_library(cove_rnnoise SHARED
  cove_rnnoise.cpp
  ${RNNOISE_DIR}/src/denoise.c
  ${RNNOISE_DIR}/src/kiss_fft.c
  ${RNNOISE_DIR}/src/pitch.c
  ${RNNOISE_DIR}/src/celt_lpc.c
  ${RNNOISE_DIR}/src/rnn.c
  ${RNNOISE_DIR}/src/rnn_data.c
  ${RNNOISE_DIR}/src/rnn_reader.c
)

target_compile_options(cove_rnnoise PRIVATE -O3 -fvisibility=hidden)

target_include_directories(cove_rnnoise PRIVATE
  ${RNNOISE_DIR}/include
  ${RNNOISE_DIR}/src
)

find_library(log-lib log)
target_link_libraries(cove_rnnoise ${log-lib})
