cmake_minimum_required(VERSION 3.22.1)
project(appmodules)

# Keep React Native's JNI_OnLoad, core TurboModule providers and Fabric
# autolinking. Building RNNoise alone omits libappmodules.so and crashes the
# release app before its first screen (PlatformConstants cannot be registered).
# This directory deliberately has no custom .cpp files, so React Native uses
# its stock OnLoad.cpp rather than treating the RNNoise JNI source as a replacement.
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

add_subdirectory("../cpp" "cove_rnnoise")
