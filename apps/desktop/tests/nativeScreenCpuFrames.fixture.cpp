// Controlled CPU-only child for nativeScreenCpuFrames.native.cjs. No capture,
// GPU, network, named objects or inherited mapping handles are used.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <array>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

struct Mapping {
  HANDLE handle = nullptr;
  unsigned char* bytes = nullptr;
  size_t length = 0;
  Mapping() = default;
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  ~Mapping() {
    if (bytes) UnmapViewOfFile(bytes);
    if (handle) CloseHandle(handle);
  }
  bool create(size_t size) {
    length = size;
    handle = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, DWORD(size), nullptr);
    if (!handle) return false;
    bytes = static_cast<unsigned char*>(MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, size));
    if (!bytes) return false;
    for (size_t i = 0; i < size; ++i) bytes[i] = static_cast<unsigned char>((i * 31 + 17) & 255);
    return true;
  }
  bool replace() {
    const HANDLE previous = handle;
    if (bytes) { UnmapViewOfFile(bytes); bytes = nullptr; }
    if (handle) { CloseHandle(handle); handle = nullptr; }
    // Bounded native handle reuse exercise. Keep other candidates open until
    // the released value is reused, then discard them; no handle-table tricks.
    std::vector<HANDLE> candidates;
    for (unsigned attempt = 0; attempt < 1024; ++attempt) {
      HANDLE next = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, DWORD(length), nullptr);
      if (!next) break;
      if (next == previous) { handle = next; break; }
      candidates.push_back(next);
    }
    for (HANDLE candidate : candidates) CloseHandle(candidate);
    if (!handle) return false;
    bytes = static_cast<unsigned char*>(MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, length));
    if (!bytes) return false;
    for (size_t i = 0; i < length; ++i) bytes[i] = static_cast<unsigned char>((i * 31 + 17) & 255);
    return true;
  }
};
int main() {
  std::array<Mapping, 3> mappings;
  const size_t sizes[]{8192, 1920 * 1080 * 3 / 2, 16 * 1024 * 1024};
  for (size_t i = 0; i < mappings.size(); ++i) if (!mappings[i].create(sizes[i])) return 2;
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!event) return 3;
  std::cout << "{\"pid\":" << GetCurrentProcessId() << ",\"mappings\":[";
  for (size_t i = 0; i < mappings.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << "{\"handle\":\"" << uint64_t(uintptr_t(mappings[i].handle))
      << "\",\"bytes\":" << mappings[i].length << '}';
  }
  std::cout << "],\"event\":\"" << uint64_t(uintptr_t(event)) << "\"}" << std::endl;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "quit") break;
    std::istringstream command(line);
    std::string verb; size_t index = 0; unsigned value = 0;
    command >> verb >> index >> value;
    if (verb == "fill" && index < mappings.size() && value <= 255) {
      FillMemory(mappings[index].bytes, mappings[index].length, value);
      std::cout << "{\"filled\":" << index << '}';
      std::cout << std::endl;
    } else if (verb == "replace" && index < mappings.size() && mappings[index].replace()) {
      std::cout << "{\"replaced\":" << index << ",\"handle\":\""
        << uint64_t(uintptr_t(mappings[index].handle)) << "\",\"reused\":true}" << std::endl;
    } else {
      CloseHandle(event);
      return 4;
    }
  }
  CloseHandle(event);
  return 0;
}
