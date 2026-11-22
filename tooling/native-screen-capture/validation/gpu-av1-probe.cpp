// Synthetic GPU-to-AV1 probe. Only compressed test data leaves the D3D device.
#define main cove_capture_main
#include "../../../apps/desktop/electron/native-screen-capture-helper.cpp"
#undef main
#include <d3d10.h>
#include <initguid.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <fstream>

static constexpr Size geometry{1728, 1080};
static constexpr UINT frameRate = 120, frameCount = 360;

static ComPtr<IMFMediaType> mediaType(REFGUID subtype) {
  ComPtr<IMFMediaType> type;
  check(MFCreateMediaType(type.GetAddressOf()), "media_type_create");
  check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "media_type_video");
  check(type->SetGUID(MF_MT_SUBTYPE, subtype), "media_subtype");
  check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, geometry.width, geometry.height), "media_frame_size");
  check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, frameRate, 1), "media_frame_rate");
  check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "media_pixel_aspect");
  check(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "media_progressive");
  check(type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709), "media_matrix");
  check(type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709), "media_primaries");
  check(type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709), "media_transfer");
  check(type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235), "media_range");
  return type;
}

static ComPtr<IMFTransform> hardwareEncoder() {
  const MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  const MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_AV1};
  IMFActivate** transforms = nullptr; UINT32 count = 0;
  check(MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
    &input, &output, &transforms, &count), "hardware_av1_enumeration");
  ComPtr<IMFTransform> result;
  for (UINT32 i = 0; i < count; ++i) {
    ComPtr<IMFActivate> candidate; candidate.Attach(transforms[i]);
    if (result) continue;
    WCHAR* name = nullptr; UINT32 length = 0;
    if (SUCCEEDED(candidate->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &name, &length)) &&
        name && std::wcsstr(name, L"NVIDIA")) {
      candidate->ActivateObject(IID_PPV_ARGS(result.GetAddressOf()));
    }
    CoTaskMemFree(name);
  }
  CoTaskMemFree(transforms);
  require(bool(result), "hardware_av1_unavailable");
  return result;
}

static void writeWord(std::ostream& stream, uint64_t value, unsigned length) {
  for (unsigned i = 0; i < length; ++i) stream.put(char((value >> (i * 8)) & 0xff));
}

static void runProbe(const char* path) {
  ComPtr<IDXGIFactory1> factory;
  check(CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf())), "dxgi_factory");
  ComPtr<IDXGIAdapter1> adapter;
  DXGI_ADAPTER_DESC1 adapterDescription{};
  for (UINT index = 0; factory->EnumAdapters1(index, adapter.ReleaseAndGetAddressOf()) == S_OK; ++index) {
    check(adapter->GetDesc1(&adapterDescription), "adapter_description");
    if (adapterDescription.VendorId == 0x10de) break;
    adapter.Reset();
  }
  require(bool(adapter), "nvidia_adapter_unavailable");
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  check(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0,
    D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "av1_d3d_device");
  ComPtr<ID3D10Multithread> threading;
  check(context.As(&threading), "av1_multithread_interface");
  threading->SetMultithreadProtected(TRUE);
  ComPtr<ID3D11DeviceContext1> context1; check(context.As(&context1), "av1_context1");
  ComPtr<ID3D11Device3> device3; check(device.As(&device3), "av1_device3");

  UINT token = 0; ComPtr<IMFDXGIDeviceManager> manager;
  check(MFCreateDXGIDeviceManager(&token, manager.GetAddressOf()), "av1_dxgi_manager");
  check(manager->ResetDevice(device.Get(), token), "av1_dxgi_reset");
  auto encoder = hardwareEncoder();
  ComPtr<IMFAttributes> attributes; check(encoder->GetAttributes(attributes.GetAddressOf()), "av1_attributes");
  UINT32 d3dAware = 0;
  check(attributes->GetUINT32(MF_SA_D3D11_AWARE, &d3dAware), "av1_d3d11_attribute");
  require(d3dAware != 0, "av1_encoder_requires_cpu");
  check(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE), "av1_async_unlock");
  check(attributes->SetUINT32(MF_LOW_LATENCY, TRUE), "av1_low_latency");
  ComPtr<ICodecAPI> codec;
  if (SUCCEEDED(encoder->QueryInterface(IID_ICodecAPI, reinterpret_cast<void**>(codec.GetAddressOf())))) {
    VARIANT value{}; value.vt = VT_BOOL; value.boolVal = VARIANT_TRUE;
    codec->SetValue(&CODECAPI_AVLowLatencyMode, &value);
    value.vt = VT_UI4; value.ulVal = 0;
    codec->SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &value);
  }
  check(encoder->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(manager.Get())), "av1_set_d3d_manager");
  auto output = mediaType(MFVideoFormat_AV1), input = mediaType(MFVideoFormat_NV12);
  check(output->SetUINT32(MF_MT_AVG_BITRATE, 10000000), "av1_bitrate");
  check(encoder->SetOutputType(0, output.Get(), 0), "av1_output_type");
  check(encoder->SetInputType(0, input.Get(), 0), "av1_gpu_input_type");
  ComPtr<IMFMediaEventGenerator> generator;
  check(encoder.As(&generator), "av1_event_generator");
  MFT_OUTPUT_STREAM_INFO outputInfo{};
  check(encoder->GetOutputStreamInfo(0, &outputInfo), "av1_output_info");
  check(encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "av1_begin");
  check(encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "av1_start");

  std::ofstream file(path, std::ios::binary);
  require(bool(file), "av1_ivf_open");
  file.write("DKIF", 4); writeWord(file, 0, 2); writeWord(file, 32, 2); file.write("AV01", 4);
  writeWord(file, geometry.width, 2); writeWord(file, geometry.height, 2);
  writeWord(file, frameRate, 4); writeWord(file, 1, 4); writeWord(file, frameCount, 4); writeWord(file, 0, 4);
  Clock clock; Timer idle;
  Handle idleCancel(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  require(idleCancel.value, "av1_wait_event");
  const uint64_t begin = clock.us(), deadline = begin + 20000000;
  std::array<uint64_t, frameCount> submittedAt{};
  std::vector<uint64_t> ages;
  UINT sent = 0, received = 0, keys = 0, inputCredits = 0;
  uint64_t outputBytes = 0;
  bool draining = false, drained = false;
  const auto desc = textureDesc(geometry.width, geometry.height, DXGI_FORMAT_NV12,
    D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE);
  while (!drained) {
    const auto now = clock.us();
    require(now < deadline, "av1_encode_timeout");
    if (sent < frameCount && inputCredits && now >= begin + sent * 1000000ULL / frameRate) {
      ComPtr<ID3D11Texture2D> texture;
      check(device->CreateTexture2D(&desc, nullptr, texture.GetAddressOf()), "av1_nv12_surface");
      D3D11_RENDER_TARGET_VIEW_DESC1 view{};
      view.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
      view.Format = DXGI_FORMAT_R8_UNORM;
      ComPtr<ID3D11RenderTargetView1> luma, chroma;
      check(device3->CreateRenderTargetView1(texture.Get(), &view, luma.GetAddressOf()), "av1_luma_view");
      view.Format = DXGI_FORMAT_R8G8_UNORM; view.Texture2D.PlaneSlice = 1;
      check(device3->CreateRenderTargetView1(texture.Get(), &view, chroma.GetAddressOf()), "av1_chroma_view");
      const FLOAT dark[]{0.25f, 0, 0, 1}, bright[]{0.75f, 0, 0, 1}, neutral[]{0.5f, 0.5f, 0, 1};
      const LONG x = LONG((sent * 20) % (geometry.width - 128));
      const D3D11_RECT patch{x, 32, x + 128, 96};
      context1->ClearView(luma.Get(), dark, nullptr, 0);
      context1->ClearView(luma.Get(), bright, &patch, 1);
      context1->ClearView(chroma.Get(), neutral, nullptr, 0);
      context->Flush();

      ComPtr<IMFMediaBuffer> surface; ComPtr<IMFSample> sample;
      check(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), texture.Get(), 0, FALSE,
        surface.GetAddressOf()), "av1_wrap_gpu_surface");
      check(MFCreateSample(sample.GetAddressOf()), "av1_sample");
      check(sample->AddBuffer(surface.Get()), "av1_attach_surface");
      const LONGLONG sampleTime = sent * 10000000LL / frameRate;
      check(sample->SetSampleTime(sampleTime), "av1_sample_time");
      check(sample->SetSampleDuration((sent + 1) * 10000000LL / frameRate - sampleTime), "av1_sample_duration");
      submittedAt[sent] = clock.us();
      check(encoder->ProcessInput(0, sample.Get(), 0), "av1_process_gpu_input");
      ++sent; --inputCredits;
      if (sent == frameCount) {
        check(encoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0), "av1_end");
        check(encoder->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0), "av1_drain");
        draining = true;
      }
    }
    ComPtr<IMFMediaEvent> event;
    const HRESULT hr = generator->GetEvent(MF_EVENT_FLAG_NO_WAIT, event.GetAddressOf());
    if (hr == MF_E_NO_EVENTS_AVAILABLE) { idle.wait(idleCancel.value, 500); continue; }
    check(hr, "av1_next_event");
    MediaEventType type{}; HRESULT status = S_OK;
    check(event->GetType(&type), "av1_event_type");
    check(event->GetStatus(&status), "av1_event_status");
    check(status, "av1_transform_error");
    if (type == METransformNeedInput) { if (!draining) ++inputCredits; continue; }
    if (type == METransformDrainComplete) { drained = true; continue; }
    if (type != METransformHaveOutput) continue;
    MFT_OUTPUT_DATA_BUFFER buffer{}; DWORD processStatus = 0;
    ComPtr<IMFSample> allocation;
    if (!(outputInfo.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES))) {
      ComPtr<IMFMediaBuffer> bytes;
      check(MFCreateMemoryBuffer(std::max<DWORD>(outputInfo.cbSize, 1024 * 1024), bytes.GetAddressOf()), "av1_output_allocate");
      check(MFCreateSample(allocation.GetAddressOf()), "av1_output_sample");
      check(allocation->AddBuffer(bytes.Get()), "av1_output_buffer");
      buffer.pSample = allocation.Get();
    }
    const HRESULT written = encoder->ProcessOutput(0, 1, &buffer, &processStatus);
    ComPtr<IMFCollection> events; events.Attach(buffer.pEvents);
    ComPtr<IMFSample> sample;
    if (buffer.pSample == allocation.Get()) sample = allocation;
    else sample.Attach(buffer.pSample);
    check(written, "av1_process_output");
    require(bool(sample), "av1_empty_output");
    LONGLONG timestamp = 0;
    check(sample->GetSampleTime(&timestamp), "av1_output_timestamp");
    const uint64_t index = (timestamp * frameRate + 5000000) / 10000000;
    require(index == received && index < sent, "av1_output_order");
    ages.push_back(clock.us() - submittedAt[index]);
    UINT32 key = 0; if (SUCCEEDED(sample->GetUINT32(MFSampleExtension_CleanPoint, &key)) && key) ++keys;
    ComPtr<IMFMediaBuffer> bitstream;
    check(sample->ConvertToContiguousBuffer(bitstream.GetAddressOf()), "av1_bitstream_buffer");
    BYTE* bytes = nullptr; DWORD length = 0;
    check(bitstream->Lock(&bytes, nullptr, &length), "av1_bitstream_lock");
    outputBytes += length;
    if (length && outputBytes <= 16 * 1024 * 1024) {
      writeWord(file, length, 4); writeWord(file, index, 8);
      file.write(reinterpret_cast<const char*>(bytes), length);
    }
    bitstream->Unlock();
    require(file && length && outputBytes <= 16 * 1024 * 1024, "av1_bitstream_write");
    ++received;
  }
  require(sent == frameCount && received == frameCount && keys, "av1_incomplete_output");
  const double rate = double(received - 1) * 1000000 / (submittedAt.back() - submittedAt.front());
  std::sort(ages.begin(), ages.end());
  std::cout << "{\"passed\":true,\"encoder\":\"Windows hardware AV1 MFT\",\"vendorId\":"
    << adapterDescription.VendorId << ",\"input\":\"DXGI NV12 surface\",\"rawCpuBytes\":0,\"width\":"
    << geometry.width << ",\"height\":" << geometry.height << ",\"frames\":" << received
    << ",\"submissionFps\":" << rate << ",\"keyFrames\":" << keys << ",\"encodedBytes\":" << outputBytes
    << ",\"processInputToOutputP95Ms\":" << ages[ages.size() * 95 / 100] / 1000.0 << "}" << std::endl;
}

int main(int argc, char** argv) {
  if (argc != 2 || FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;
  if (FAILED(MFStartup(MF_VERSION))) { CoUninitialize(); return 2; }
  int status = 0;
  try { runProbe(argv[1]); }
  catch (const std::exception& error) { std::cerr << error.what() << std::endl; status = 1; }
  MFShutdown();
  CoUninitialize();
  return status;
}
