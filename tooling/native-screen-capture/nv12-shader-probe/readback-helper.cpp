// Synthetic readback controls only. Reuse the existing shader/compiler/owner
// primitives. No desktop, encoder or product provider code is included.
#define main immutableProbeMain
#include "helper.cpp"
#undef main
#include <vector>
#include <memory>
#include <sstream>

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif
// Stream-fixture-only waits. The older immutable helper's gpuComplete() and
// command() controls stay unchanged. No global timer resolution or spin waiting.
struct StreamClock {
  LARGE_INTEGER frequency{};
  StreamClock() { require(QueryPerformanceFrequency(&frequency) && frequency.QuadPart > 0, "stream_qpc_unavailable"); }
  LONGLONG now() const { LARGE_INTEGER value{}; require(QueryPerformanceCounter(&value), "stream_qpc_failed"); return value.QuadPart; }
  uint64_t microseconds(LONGLONG ticks) const { return uint64_t(ticks * 1000000 / frequency.QuadPart); }
};
enum class StreamWaitResult { Timer, OwnerExited, Deadline };
struct StreamPollTimer {
  const StreamClock& clock;
  Handle timer;
  explicit StreamPollTimer(const StreamClock& source) : clock(source),
    timer(CreateWaitableTimerExW(nullptr,nullptr,CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,TIMER_MODIFY_STATE | SYNCHRONIZE)) {
    require(timer.value != nullptr, "stream_high_resolution_timer_unavailable");
  }
  ~StreamPollTimer() { if (timer.value) CancelWaitableTimer(timer.value); }
  StreamWaitResult wait(HANDLE owner, LONGLONG deadline) {
    // Owner precedes the timer in the multiwait and is rechecked after wake.
    // Even an already expired deadline cannot take precedence over owner exit.
    if (!alive(owner)) return StreamWaitResult::OwnerExited;
    const LONGLONG remaining = deadline - clock.now();
    if (remaining <= 0) return StreamWaitResult::Deadline;
    const LONGLONG remaining100ns = std::max<LONGLONG>(1,(remaining * 10000000 + clock.frequency.QuadPart - 1) / clock.frequency.QuadPart);
    LARGE_INTEGER due{}; due.QuadPart = -std::min<LONGLONG>(2500,remaining100ns); // 250 us, relative and one-shot.
    require(SetWaitableTimerEx(timer.value,&due,0,nullptr,nullptr,nullptr,0), "stream_poll_timer_arm_failed");
    const HANDLE handles[]{owner,timer.value};
    const DWORD boundMs = DWORD(std::max<LONGLONG>(1,std::min<LONGLONG>(3000,(remaining * 1000 + clock.frequency.QuadPart - 1) / clock.frequency.QuadPart)));
    const DWORD result = WaitForMultipleObjects(2,handles,FALSE,boundMs);
    if (result == WAIT_OBJECT_0 || !alive(owner)) return StreamWaitResult::OwnerExited;
    if (clock.now() >= deadline) return StreamWaitResult::Deadline;
    require(result == WAIT_OBJECT_0 + 1, "stream_poll_timer_wait_failed");
    return StreamWaitResult::Timer;
  }
};
struct StreamGpuWait {
  uint64_t wallUs = 0, polls = 0, timerWaits = 0;
};
static std::string streamCommand(HANDLE owner, HANDLE input, StreamPollTimer& timer, LONGLONG deadline) {
  std::string line;
  while (true) {
    // An exited owner wins even when the absolute deadline has also expired.
    require(alive(owner), "owner_exited");
    require(timer.clock.now() < deadline, "owner_command_timeout");
    DWORD available = 0;
    require(PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr), "owner_pipe_closed");
    require(alive(owner), "owner_exited");
    require(timer.clock.now() < deadline, "owner_command_timeout");
    if (!available) {
      const auto wake = timer.wait(owner,deadline);
      require(wake != StreamWaitResult::OwnerExited, "owner_exited");
      require(wake != StreamWaitResult::Deadline, "owner_command_timeout");
      continue;
    }
    require(available <= 1024, "owner_command_overflow");
    char byte = 0; DWORD read = 0;
    require(ReadFile(input,&byte,1,&read,nullptr) && read == 1, "owner_pipe_closed");
    require(alive(owner), "owner_exited");
    require(timer.clock.now() < deadline, "owner_command_timeout");
    if (byte == '\n') return line;
    if (byte != '\r') line += byte;
    require(line.size() <= 32, "owner_command_overflow");
  }
}
struct StreamCompletion {
  StreamClock clock;
  StreamPollTimer timer;
  ComPtr<ID3D11Query> query;
  explicit StreamCompletion(ID3D11Device* device) : timer(clock) {
    const D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT,0};
    check(device->CreateQuery(&desc,query.GetAddressOf()), "gpu_query_create_failed");
  }
  StreamGpuWait complete(ID3D11Device* device, ID3D11DeviceContext* context, HANDLE owner) {
    require(alive(owner), "owner_exited");
    const LONGLONG started = clock.now(),deadline = started + 3 * clock.frequency.QuadPart;
    context->End(query.Get()); context->Flush(); StreamGpuWait measurement;
    const auto timeout = [&]() { removedReason = device->GetDeviceRemovedReason(); throw Failure("gpu_completion_timeout"); };
    while (true) {
      require(alive(owner), "owner_exited");
      if (clock.now() >= deadline) timeout();
      const HRESULT result = context->GetData(query.Get(),nullptr,0,D3D11_ASYNC_GETDATA_DONOTFLUSH); ++measurement.polls;
      require(alive(owner), "owner_exited");
      if (clock.now() >= deadline) timeout();
      if (result == S_OK) break;
      if (result != S_FALSE) { removedReason = device->GetDeviceRemovedReason(); check(result,"gpu_completion_failed"); }
      const auto wake = timer.wait(owner,deadline); ++measurement.timerWaits;
      require(wake != StreamWaitResult::OwnerExited, "owner_exited");
      if (wake == StreamWaitResult::Deadline) timeout();
    }
    require(alive(owner), "owner_exited"); check(device->GetDeviceRemovedReason(),"gpu_device_lost");
    measurement.wallUs = clock.microseconds(clock.now() - started); return measurement;
  }
};
static void streamTimerSelfTest() {
  StreamClock clock; StreamPollTimer timer(clock);
  Handle owner(CreateEventW(nullptr,TRUE,FALSE,nullptr)); require(owner.value != nullptr,"stream_timer_test_owner_create_failed");
  const auto started = clock.now();
  for (UINT count = 0; count < 8; ++count)
    require(timer.wait(owner.value,clock.now() + clock.frequency.QuadPart) == StreamWaitResult::Timer,"stream_timer_test_wait_failed");
  require(SetEvent(owner.value),"stream_timer_test_owner_signal_failed");
  require(timer.wait(owner.value,clock.now() + clock.frequency.QuadPart) == StreamWaitResult::OwnerExited,"stream_timer_test_owner_priority_failed");
  require(timer.wait(owner.value,clock.now() - 1) == StreamWaitResult::OwnerExited,"stream_timer_test_owner_deadline_priority_failed");
  require(ResetEvent(owner.value),"stream_timer_test_owner_reset_failed");
  require(timer.wait(owner.value,clock.now() - 1) == StreamWaitResult::Deadline,"stream_timer_test_deadline_failed");
  std::cout << "{\"type\":\"timer-self-test\",\"probe\":\"synthetic-readback-stream\",\"passed\":true,\"pollUs\":250,\"timerWaits\":8,\"wallUs\":"
    << clock.microseconds(clock.now()-started) << ",\"ownerPriorityPassed\":true,\"deadlinePassed\":true,\"gpuExecuted\":false}" << std::endl;
}
struct StreamFragmentWriter { HANDLE pipe = nullptr; bool passed = false; };
static DWORD WINAPI writeStreamCommandFragments(void* state) {
  auto& writer = *static_cast<StreamFragmentWriter*>(state);
  Handle timer(CreateWaitableTimerExW(nullptr,nullptr,CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,TIMER_MODIFY_STATE | SYNCHRONIZE));
  if (!timer.value) return 1;
  LARGE_INTEGER due{}; due.QuadPart = -100000; // Test-only delayed second fragment: 10 ms.
  if (!SetWaitableTimerEx(timer.value,&due,0,nullptr,nullptr,nullptr,0) || WaitForSingleObject(timer.value,1000) != WAIT_OBJECT_0) return 1;
  const char tail[] = "rted 0 1\r\nreleased 0 1\nstop\n"; DWORD written = 0;
  writer.passed = WriteFile(writer.pipe,tail,DWORD(sizeof(tail)-1),&written,nullptr) && written == sizeof(tail)-1;
  return writer.passed ? 0 : 1;
}
static void streamCommandSelfTest() {
  StreamClock clock; StreamPollTimer timer(clock);
  Handle owner(CreateEventW(nullptr,TRUE,FALSE,nullptr)); require(owner.value != nullptr,"stream_command_test_owner_create_failed");
  Handle input,output; require(CreatePipe(&input.value,&output.value,nullptr,0),"stream_command_test_pipe_create_failed");
  const char head[] = "impo"; DWORD written = 0;
  require(WriteFile(output.value,head,DWORD(sizeof(head)-1),&written,nullptr) && written == sizeof(head)-1,"stream_command_test_write_failed");
  StreamFragmentWriter writer{output.value,false}; Handle thread(CreateThread(nullptr,0,writeStreamCommandFragments,&writer,0,nullptr));
  require(thread.value != nullptr,"stream_command_test_thread_failed");
  // Always join before unwinding the stack-owned writer state.
  try {
    const auto deadline = clock.now() + clock.frequency.QuadPart;
    require(streamCommand(owner.value,input.value,timer,deadline) == "imported 0 1","stream_command_test_fragment_failed");
    require(streamCommand(owner.value,input.value,timer,deadline) == "released 0 1","stream_command_test_burst_failed");
    require(streamCommand(owner.value,input.value,timer,deadline) == "stop","stream_command_test_stop_failed");
  } catch (...) { WaitForSingleObject(thread.value,INFINITE); throw; }
  require(WaitForSingleObject(thread.value,INFINITE) == WAIT_OBJECT_0 && writer.passed,"stream_command_test_writer_failed");
  const auto expect = [&](const char* code, LONGLONG deadline) {
    try { (void)streamCommand(owner.value,input.value,timer,deadline); }
    catch (const Failure& error) { require(std::strcmp(error.what(),code) == 0,"stream_command_test_wrong_failure"); return; }
    throw Failure("stream_command_test_missing_failure");
  };
  expect("owner_command_timeout",clock.now()-1);
  expect("owner_command_timeout",clock.now()+clock.frequency.QuadPart/200); // Idle pipe deadline.
  require(SetEvent(owner.value),"stream_command_test_owner_signal_failed");
  expect("owner_exited",clock.now()-1);
  require(ResetEvent(owner.value),"stream_command_test_owner_reset_failed");
  CloseHandle(output.value); output.value = nullptr;
  expect("owner_pipe_closed",clock.now()+clock.frequency.QuadPart);
  std::cout << "{\"type\":\"command-self-test\",\"probe\":\"synthetic-readback-stream\",\"passed\":true,\"fragmentPassed\":true,\"burstPassed\":true,\"stopPassed\":true,\"eofPassed\":true,\"ownerPriorityPassed\":true,\"deadlinePassed\":true,\"gpuExecuted\":false}" << std::endl;
}

struct StreamOptions {
  DWORD ownerPid = 0;
  UINT width = 0, height = 0, pool = 0, frames = 0;
  bool nv12 = false;
};
static UINT number(const char* text, UINT maximum) {
  const std::string input(text); require(!input.empty() && input.size() <= 10, "invalid_stream_number");
  uint64_t value = 0;
  for (char digit : input) {
    require(digit >= '0' && digit <= '9', "invalid_stream_number");
    value = value * 10 + unsigned(digit - '0'); require(value <= maximum, "invalid_stream_number");
  }
  require(value != 0, "invalid_stream_number"); return UINT(value);
}
static StreamOptions streamOptions(int argc, char** argv) {
  StreamOptions result; bool formatSeen = false;
  for (int index = 1; index < argc; ++index) {
    const std::string argument(argv[index]); require(++index < argc, "invalid_stream_arguments");
    if (argument == "--owner-pid") { require(!result.ownerPid, "invalid_stream_arguments"); result.ownerPid = number(argv[index], MAXDWORD); }
    else if (argument == "--width") { require(!result.width, "invalid_stream_arguments"); result.width = number(argv[index], 1920); }
    else if (argument == "--height") { require(!result.height, "invalid_stream_arguments"); result.height = number(argv[index], 1080); }
    else if (argument == "--pool-size") { require(!result.pool, "invalid_stream_arguments"); result.pool = number(argv[index], 3); }
    else if (argument == "--frames") { require(!result.frames, "invalid_stream_arguments"); result.frames = number(argv[index], 250); }
    else if (argument == "--pixel-format") { require(!formatSeen, "invalid_stream_arguments"); formatSeen = true;
      const std::string format(argv[index]); require(format == "nv12" || format == "bgra", "invalid_stream_format"); result.nv12 = format == "nv12"; }
    else throw Failure("invalid_stream_arguments");
  }
  require(result.ownerPid == parentPid() && result.ownerPid, "owner_is_not_parent");
  require((result.width == 64 && result.height == 64) ||
    ((result.width == 1728 || result.width == 1920) && result.height == 1080), "invalid_stream_geometry");
  require(formatSeen && (result.pool == 1 || result.pool == 3) && result.frames >= result.pool, "invalid_stream_arguments");
  return result;
}
static Pixel streamPixel(UINT x, UINT y, UINT width, UINT height, UINT serial) {
  // Eight 2x2 grayscale bits are an exact sequence marker, stable under NV12
  // subsampling. The remaining source is the independent existing 64x64 golden.
  if (y < 2 && x < 16) { const unsigned char value = serial & (1u << (x / 2)) ? 224 : 32; return {value,value,value,255}; }
  return sourcePixel(x * kWidth / width, y * kHeight / height);
}
static void streamSelfTest() {
  selfTest();
  for (const UINT width : {64u,1728u,1920u}) for (const UINT serial : {1u,2u,3u,127u,250u}) {
    UINT decoded = 0;
    for (UINT bit = 0; bit < 8; ++bit) {
      const auto pixel = streamPixel(bit * 2, 0, width, width == 64 ? 64 : 1080, serial);
      require(pixel[0] == pixel[1] && pixel[1] == pixel[2] && pixel[3] == 255, "sequence_self_test_failed");
      if (pixel[0] > 128) decoded |= 1u << bit;
      require(streamPixel(bit * 2 + 1, 1, width, width == 64 ? 64 : 1080, serial) == pixel, "sequence_block_self_test_failed");
    }
    require(decoded == serial, "sequence_self_test_failed");
  }
  streamTimerSelfTest();
  streamCommandSelfTest();
  std::cout << "{\"type\":\"self-test\",\"probe\":\"synthetic-readback-stream\",\"passed\":true,\"gpuExecuted\":false}" << std::endl;
}
static void streamProbe(const StreamOptions& options) {
  Handle owner(OpenProcess(SYNCHRONIZE, FALSE, options.ownerPid)); require(owner.value && alive(owner.value), "owner_unavailable");
  const auto shaders = compileShaders();
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL requested[]{D3D_FEATURE_LEVEL_11_0}; D3D_FEATURE_LEVEL actual{};
  check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    requested, 1, D3D11_SDK_VERSION, device.GetAddressOf(), &actual, context.GetAddressOf()), "hardware_device_unsupported");
  require(actual >= D3D_FEATURE_LEVEL_11_0, "feature_level_11_required");
  StreamCompletion completion(device.Get());
  ComPtr<ID3D11Device3> device3; check(device.As(&device3), "device3_plane_views_unsupported");
  D3D11_TEXTURE2D_DESC desc{}; desc.Width = options.width; desc.Height = options.height;
  desc.MipLevels = 1; desc.ArraySize = 1; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  std::vector<unsigned char> pixels(size_t(options.width) * options.height * 4);
  for (UINT y = 0; y < options.height; ++y) for (UINT x = 0; x < options.width; ++x) {
    const auto pixel = streamPixel(x,y,options.width,options.height,0);
    std::copy(pixel.begin(), pixel.end(), pixels.begin() + (size_t(y) * options.width + x) * 4);
  }
  const D3D11_SUBRESOURCE_DATA initial{pixels.data(), options.width * 4, 0};
  ComPtr<ID3D11Texture2D> input; check(device->CreateTexture2D(&desc, &initial, input.GetAddressOf()), "synthetic_bgra_texture_failed");
  SecureZeroMemory(pixels.data(), pixels.size()); pixels.clear();
  ComPtr<ID3D11ShaderResourceView> source; check(device->CreateShaderResourceView(input.Get(), nullptr, source.GetAddressOf()), "synthetic_bgra_srv_failed");
  ComPtr<ID3D11VertexShader> vertex; ComPtr<ID3D11PixelShader> luma, chroma;
  check(device->CreateVertexShader(shaders.vertex->GetBufferPointer(), shaders.vertex->GetBufferSize(), nullptr, vertex.GetAddressOf()), "vertex_shader_create_failed");
  check(device->CreatePixelShader(shaders.luma->GetBufferPointer(), shaders.luma->GetBufferSize(), nullptr, luma.GetAddressOf()), "luma_shader_create_failed");
  check(device->CreatePixelShader(shaders.chroma->GetBufferPointer(), shaders.chroma->GetBufferSize(), nullptr, chroma.GetAddressOf()), "chroma_shader_create_failed");
  D3D11_RASTERIZER_DESC rasterDesc{}; rasterDesc.FillMode = D3D11_FILL_SOLID; rasterDesc.CullMode = D3D11_CULL_NONE; rasterDesc.DepthClipEnable = TRUE;
  ComPtr<ID3D11RasterizerState> raster; check(device->CreateRasterizerState(&rasterDesc, raster.GetAddressOf()), "raster_state_create_failed");
  struct Slot {
    ComPtr<ID3D11Texture2D> texture; ComPtr<ID3D11RenderTargetView1> y, uv;
    ComPtr<IDXGIKeyedMutex> mutex; Handle shared; UINT serial = 0; bool imported = false;
  };
  std::array<std::unique_ptr<Slot>,3> slots;
  desc.Format = options.nv12 ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  for (UINT index = 0; index < options.pool; ++index) {
    slots[index] = std::make_unique<Slot>(); auto& slot = *slots[index];
    check(device->CreateTexture2D(&desc, nullptr, slot.texture.GetAddressOf()), "stream_shared_texture_unsupported");
    check(slot.texture.As(&slot.mutex), "stream_keyed_mutex_unsupported");
    ComPtr<IDXGIResource1> resource; check(slot.texture.As(&resource), "stream_nt_resource_unsupported");
    check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &slot.shared.value), "stream_nt_shared_handle_unsupported");
    if (options.nv12) {
      D3D11_RENDER_TARGET_VIEW_DESC1 view{}; view.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
      view.Format = DXGI_FORMAT_R8_UNORM; view.Texture2D.PlaneSlice = 0;
      check(device3->CreateRenderTargetView1(slot.texture.Get(), &view, slot.y.GetAddressOf()), "nv12_luma_rtv1_unsupported");
      view.Format = DXGI_FORMAT_R8G8_UNORM; view.Texture2D.PlaneSlice = 1;
      check(device3->CreateRenderTargetView1(slot.texture.Get(), &view, slot.uv.GetAddressOf()), "nv12_chroma_rtv1_unsupported");
    }
  }
  const char* format = options.nv12 ? "nv12" : "bgra";
  std::cout << "{\"type\":\"ready\",\"probe\":\"synthetic-readback-stream\",\"protocol\":3,\"width\":" << options.width
    << ",\"height\":" << options.height << ",\"poolSize\":" << options.pool << ",\"frames\":" << options.frames
    << ",\"pixelFormat\":\"" << format << "\",\"pattern\":\"scaled-golden-sequence-bits-v1\",\"syncMode\":\"held-query\",\"gpuCompletionWait\":\"private-high-resolution-timer\",\"gpuPollUs\":250,\"queryReused\":true,\"ownerCommandWait\":\"private-high-resolution-timer\",\"ownerCommandPollUs\":250,\"ownerCommandDeadlineMs\":20000}" << std::endl;
  UINT issued = 0, released = 0;
  const auto submit = [&](UINT index) {
    auto& slot = *slots[index]; require(!slot.serial && alive(owner.value), "stream_slot_not_released");
    const LONGLONG issueStarted = completion.clock.now(); StreamGpuWait gpuWait;
    const UINT serial = ++issued;
    std::array<unsigned char,16 * 2 * 4> marker{};
    for (UINT y = 0; y < 2; ++y) for (UINT x = 0; x < 16; ++x) {
      const auto pixel = streamPixel(x,y,options.width,options.height,serial);
      std::copy(pixel.begin(), pixel.end(), marker.begin() + (y * 16 + x) * 4);
    }
    const D3D11_BOX box{0,0,0,16,2,1}; context->UpdateSubresource(input.Get(),0,&box,marker.data(),16*4,0);
    require(slot.mutex->AcquireSync(0,100) == S_OK, "stream_mutex_unavailable"); bool held = true;
    try {
      if (options.nv12) {
        context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertex.Get(),nullptr,0); context->RSSetState(raster.Get());
        ID3D11ShaderResourceView* srv = source.Get(); context->PSSetShaderResources(0,1,&srv);
        const auto draw = [&](ID3D11RenderTargetView* target, ID3D11PixelShader* shader, UINT width, UINT height) {
          const D3D11_VIEWPORT viewport{0,0,float(width),float(height),0,1}; context->RSSetViewports(1,&viewport);
          context->OMSetRenderTargets(1,&target,nullptr); context->PSSetShader(shader,nullptr,0); context->Draw(3,0);
        };
        draw(slot.y.Get(),luma.Get(),options.width,options.height); draw(slot.uv.Get(),chroma.Get(),options.width/2,options.height/2);
        context->OMSetRenderTargets(0,nullptr,nullptr); srv = nullptr; context->PSSetShaderResources(0,1,&srv);
      } else context->CopyResource(slot.texture.Get(),input.Get());
      gpuWait = completion.complete(device.Get(),context.Get(),owner.value);
      check(slot.mutex->ReleaseSync(0), "stream_mutex_release_failed"); held = false;
    } catch (...) { if (held) slot.mutex->ReleaseSync(0); throw; }
    slot.serial = serial; slot.imported = false;
    // Handle values are transient owner transport metadata. The owner must not log them.
    std::cout << "{\"type\":\"frame\",\"probe\":\"synthetic-readback-stream\",\"slot\":" << index << ",\"serial\":" << serial
      << ",\"timestamp\":" << serial * 1000 << ",\"width\":" << options.width << ",\"height\":" << options.height
      << ",\"pixelFormat\":\"" << format << "\",\"producerGpuComplete\":true,\"handle\":\"0x"
      << std::hex << uintptr_t(slot.shared.value) << std::dec << "\",\"producerGpuWaitUs\":" << gpuWait.wallUs
      << ",\"producerQueryPolls\":" << gpuWait.polls << ",\"producerTimerWaits\":" << gpuWait.timerWaits
      << ",\"sourceIssueWallUs\":" << completion.clock.microseconds(completion.clock.now()-issueStarted) << "}" << std::endl;
    require(bool(std::cout), "owner_output_closed");
  };
  for (UINT index = 0; index < options.pool; ++index) submit(index);
  bool stopped = false;
  while (released < options.frames) {
    const auto line = streamCommand(owner.value,GetStdHandle(STD_INPUT_HANDLE),completion.timer,
      completion.clock.now() + 20 * completion.clock.frequency.QuadPart);
    if (line == "stop") { stopped = true; break; }
    std::istringstream parsed(line); std::string verb, extra; UINT index = 0, serial = 0;
    require(bool(parsed >> verb >> index >> serial) && !(parsed >> extra) && index < options.pool, "invalid_stream_ack");
    auto& slot = *slots[index]; require(slot.serial == serial && serial, "stale_stream_ack");
    if (verb == "imported") { require(!slot.imported, "duplicate_import_ack"); slot.imported = true; }
    else if (verb == "released") {
      require(slot.imported, "release_before_import_ack"); slot.serial = 0; slot.imported = false; ++released;
      if (issued < options.frames) submit(index);
    } else throw Failure("invalid_stream_ack");
  }
  std::cout << "{\"type\":\"done\",\"probe\":\"synthetic-readback-stream\",\"frames\":" << issued
    << ",\"released\":" << released << ",\"allReferencesReleased\":" << (!stopped && released == issued ? "true" : "false") << "}" << std::endl;
}
int main(int argc, char** argv) {
  try { if (argc == 2 && std::string(argv[1]) == "--self-test") streamSelfTest(); else streamProbe(streamOptions(argc,argv)); return 0; }
  catch (const Failure& error) { std::cout << "{\"type\":\"error\",\"probe\":\"synthetic-readback-stream\",\"code\":\"" << error.what()
    << "\",\"hresult\":" << int32_t(lastHr) << ",\"deviceRemovedReason\":" << int32_t(removedReason) << "}" << std::endl; return 2; }
  catch (...) { std::cout << "{\"type\":\"error\",\"probe\":\"synthetic-readback-stream\",\"code\":\"internal_failure\"}" << std::endl; return 2; }
}
