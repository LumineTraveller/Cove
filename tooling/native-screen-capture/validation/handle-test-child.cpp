#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <cstdint>
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  HANDLE parent = OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, DWORD(std::stoul(argv[1])));
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!parent || !event) return 3;
  std::vector<HANDLE> allocated;
  std::cout << "{\"type\":\"ready\",\"handle\":\"0x" << std::hex << uintptr_t(event) << "\"}" << std::endl;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "stop") break;
    if (line == "allocate") {
      HANDLE remote = nullptr;
      if (!DuplicateHandle(GetCurrentProcess(), event, parent, &remote, 0, FALSE, DUPLICATE_SAME_ACCESS)) return 4;
      allocated.push_back(remote);
      std::cout << "{\"handle\":\"0x" << std::hex << uintptr_t(remote) << "\"}" << std::endl;
    } else if (line.rfind("check ", 0) == 0) {
      HANDLE remote = reinterpret_cast<HANDLE>(uintptr_t(std::stoull(line.substr(6), nullptr, 16)));
      HANDLE local = nullptr;
      bool valid = DuplicateHandle(parent, remote, GetCurrentProcess(), &local, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE;
      if (valid) { valid = SetEvent(local) != FALSE; ResetEvent(local); CloseHandle(local); }
      std::cout << "{\"valid\":" << (valid ? "true" : "false") << "}" << std::endl;
    } else return 5;
  }
  for (HANDLE remote : allocated) DuplicateHandle(parent, remote, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
  CloseHandle(event); CloseHandle(parent); return 0;
}
