// One immutable synthetic frame. No desktop capture, encoder, image output or addon.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <array>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
static void check(HRESULT hr, const char* stage) {
  if (FAILED(hr)) { std::ostringstream out; out << stage << ":0x" << std::hex << uint32_t(hr); throw std::runtime_error(out.str()); }
}
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
static DWORD parentPid() {
  Handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
  if (snapshot.value == INVALID_HANDLE_VALUE) throw std::runtime_error("process_snapshot_failed");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.value, &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.value, &entry));
  throw std::runtime_error("parent_not_found");
}
struct RemoteHandle {
  HANDLE parent = nullptr, value = nullptr;
  // Electron import duplicates this handle. Close our original in Electron's
  // handle table exactly once, including failure/EOF paths; never retry a close.
  void close() {
    if (!value) return;
    HANDLE original = value; value = nullptr;
    if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) return;
    if (!DuplicateHandle(parent, original, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE))
      throw std::runtime_error("close_main_temporary_handle_failed");
  }
  ~RemoteHandle() { try { close(); } catch (...) {} }
};
static std::string command(HANDLE parent, ULONGLONG deadline) {
  std::string line;
  while (GetTickCount64() < deadline) {
    if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) throw std::runtime_error("owner_exited");
    DWORD count = 0;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &count, nullptr)) throw std::runtime_error("owner_pipe_closed");
    if (count) {
      char ch = 0; DWORD read = 0;
      if (!ReadFile(input, &ch, 1, &read, nullptr) || read != 1) throw std::runtime_error("owner_pipe_read_failed");
      if (ch == '\n') return line;
      if (ch != '\r') line += ch;
      if (line.size() > 32) throw std::runtime_error("invalid_owner_command");
    } else Sleep(2);
  }
  throw std::runtime_error("owner_command_timeout");
}
int main(int argc, char** argv) {
  try {
    if (argc != 3 || std::string(argv[1]) != "--owner-pid") throw std::runtime_error("explicit_owner_required");
    size_t consumed = 0; const unsigned long parsed = std::stoul(argv[2], &consumed);
    if (!parsed || consumed != std::string(argv[2]).size() || parsed != parentPid()) throw std::runtime_error("owner_is_not_parent");
    const DWORD ownerPid = DWORD(parsed);
    Handle parent{OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, ownerPid)};
    if (!parent.value || WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT) throw std::runtime_error("owner_unavailable");
    ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "create_hardware_device");
    D3D11_TEXTURE2D_DESC desc{}; desc.Width = 64; desc.Height = 64; desc.MipLevels = 1;
    desc.ArraySize = 1; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    ComPtr<ID3D11Texture2D> texture; check(device->CreateTexture2D(&desc, nullptr, texture.GetAddressOf()), "create_shared_texture");
    ComPtr<IDXGIKeyedMutex> mutex; check(texture.As(&mutex), "query_keyed_mutex");
    if (mutex->AcquireSync(0, 1000) != S_OK) throw std::runtime_error("initial_mutex_unavailable");
    std::array<unsigned char, 64 * 64 * 4> pixels{};
    for (unsigned y = 0; y < 64; ++y) for (unsigned x = 0; x < 64; ++x) {
      const bool top = y < 32, left = x < 32;
      unsigned char r = left ? (top ? 255 : 0) : (top ? 0 : 255);
      unsigned char g = left ? 0 : 255, b = left && !top ? 255 : 0;
      const int dy = int(y) - 31;
      const bool arrow = (x >= 12 && x <= 43 && dy >= -2 && dy <= 2) ||
        (x >= 42 && x <= 52 && dy >= -int(52 - x) && dy <= int(52 - x));
      if (arrow) r = g = b = 255;
      const size_t offset = (y * 64 + x) * 4;
      pixels[offset] = b; pixels[offset + 1] = g; pixels[offset + 2] = r; pixels[offset + 3] = 255;
    }
    context->UpdateSubresource(texture.Get(), 0, nullptr, pixels.data(), 64 * 4, 0);
    SecureZeroMemory(pixels.data(), pixels.size());
    D3D11_QUERY_DESC queryDesc{D3D11_QUERY_EVENT, 0}; ComPtr<ID3D11Query> query;
    check(device->CreateQuery(&queryDesc, query.GetAddressOf()), "create_completion_query");
    context->End(query.Get()); context->Flush(); const ULONGLONG gpuDeadline = GetTickCount64() + 3000;
    while (true) {
      const HRESULT ready = context->GetData(query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
      if (ready == S_OK) break;
      check(ready, "gpu_completion_query");
      if (GetTickCount64() >= gpuDeadline || WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT)
        throw std::runtime_error("gpu_completion_timeout_or_owner_exit");
      Sleep(1);
    }
    check(mutex->ReleaseSync(0), "release_initial_mutex");
    ComPtr<IDXGIResource1> resource; check(texture.As(&resource), "query_resource1");
    Handle local; check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
      nullptr, &local.value), "create_nt_handle");
    RemoteHandle remote{parent.value, nullptr};
    if (!DuplicateHandle(GetCurrentProcess(), local.value, parent.value, &remote.value, 0, FALSE, DUPLICATE_SAME_ACCESS))
      throw std::runtime_error("duplicate_into_owner_failed");
    std::cout << "{\"type\":\"ready\",\"ownerPid\":" << ownerPid << ",\"helperPid\":" << GetCurrentProcessId()
      << ",\"mainHandle\":\"0x" << std::hex << uintptr_t(remote.value) << std::dec
      << "\",\"width\":64,\"height\":64,\"timestamp\":1000,\"producerGpuComplete\":true}" << std::endl;
    const auto deadline = GetTickCount64() + 20000;
    if (command(parent.value, deadline) != "imported") throw std::runtime_error("expected_import_confirmation");
    remote.close();
    std::cout << "{\"type\":\"main-handle-closed\"}" << std::endl;
    if (command(parent.value, deadline) != "released") throw std::runtime_error("expected_all_references_released");
    check(device->GetDeviceRemovedReason(), "device_removed");
    std::cout << "{\"type\":\"done\",\"allReferencesReleaseAcknowledged\":true}" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    // All errors are fixed stage names/HRESULTs, never pixels or OS source data.
    std::cerr << error.what() << std::endl; return 2;
  }
}
