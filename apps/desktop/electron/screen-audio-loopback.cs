using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Windows process loopback with a sample position for every packet. stdout is
// a binary stream, and closing stdin stops the capture.
public static class ScreenAudioLoopback
{
    private const int SampleRate = 48000;
    private const int FrameBytes = 4;
    private const int MaxQueuedFrames = SampleRate / 2;
    private const uint Silent = 0x2;
    private const uint TimestampError = 0x4;
    private const uint Loopback = 0x20000;
    private const uint EventCallback = 0x40000;
    private const uint AutoConvertPcm = 0x80000000;

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat {
        public ushort Format, Channels;
        public uint Rate, BytesPerSecond;
        public ushort BlockAlign, Bits, ExtraSize;
    }

    // PROPVARIANT VT_BLOB and AUDIOCLIENT_ACTIVATION_PARAMS on Windows x64.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct ActivationVariant {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public int BlobSize;
        [FieldOffset(16)] public IntPtr Blob;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient {
        // Unused methods keep the native vtable slots.
        [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, ref WaveFormat format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long duration);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, ref WaveFormat format, IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong counterPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation {
        [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }

    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ActivateAudioInterfaceAsync(
        string device, ref Guid iid, ref ActivationVariant parameters, IActivateAudioInterfaceCompletionHandler completion,
        out IActivateAudioInterfaceAsyncOperation operation);

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ActivationCompletion : IActivateAudioInterfaceCompletionHandler, IAgileObject {
        public readonly ManualResetEvent ready = new ManualResetEvent(false);
        public object client;
        public int result;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) {
            int activationResult;
            result = operation.GetActivateResult(out activationResult, out client);
            if (result >= 0) result = activationResult;
            ready.Set();
            return 0;
        }
    }

    private static IAudioClient Open(int processId, bool includeProcessTree) {
        IntPtr blob = Marshal.AllocHGlobal(12);
        IActivateAudioInterfaceAsyncOperation operation = null;
        var completion = new ActivationCompletion();
        try {
            // ActivationType = PROCESS_LOOPBACK, followed by PID and mode.
            Marshal.WriteInt32(blob, 0, 1);
            Marshal.WriteInt32(blob, 4, processId);
            Marshal.WriteInt32(blob, 8, includeProcessTree ? 0 : 1);
            var parameters = new ActivationVariant { Type = 65, BlobSize = 12, Blob = blob };
            Guid iid = typeof(IAudioClient).GUID;
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync(
                @"VAD\Process_Loopback", ref iid, ref parameters, completion, out operation));
            completion.ready.WaitOne();
            Marshal.ThrowExceptionForHR(completion.result);
            return (IAudioClient)completion.client;
        } finally {
            if (operation != null) Marshal.ReleaseComObject(operation);
            completion.ready.Dispose();
            Marshal.FreeHGlobal(blob);
        }
    }

    private sealed class SamplePosition {
        private ulong? lastDevicePosition;
        private ulong lastPacketPosition;
        private ulong nextPosition;

        public ulong Advance(ulong devicePosition, uint frames, bool validTimestamp) {
            ulong position = nextPosition;
            if (validTimestamp) {
                if (lastDevicePosition.HasValue && devicePosition >= lastDevicePosition.Value) {
                    ulong elapsed = devicePosition - lastDevicePosition.Value;
                    position = Math.Max(position, lastPacketPosition + elapsed);
                }
                lastDevicePosition = devicePosition;
                lastPacketPosition = position;
            }
            nextPosition = position + frames;
            return position;
        }
    }

    private sealed class Packet {
        public ulong Position;
        public int Frames;
        public byte[] Data;
    }

    // The pipe can block behind Electron. Keep it on a separate thread so
    // WASAPI is drained promptly, and bound queued historical audio by frames.
    private sealed class Output {
        private readonly Queue<Packet> packets = new Queue<Packet>();
        private readonly AutoResetEvent available = new AutoResetEvent(false);
        private readonly ManualResetEvent stopped;
        private int queuedFrames;

        public Output(ManualResetEvent stopped) { this.stopped = stopped; }

        public void Enqueue(Packet packet) {
            lock (packets) {
                while (queuedFrames + packet.Frames > MaxQueuedFrames && packets.Count > 0)
                    queuedFrames -= packets.Dequeue().Frames;
                packets.Enqueue(packet);
                queuedFrames += packet.Frames;
            }
            available.Set();
        }

        public void Write() {
            try {
                using (var writer = new BinaryWriter(Console.OpenStandardOutput())) {
                    writer.Write(Encoding.ASCII.GetBytes("COVEPCM1"));
                    writer.Flush();
                    var handles = new WaitHandle[] { stopped, available };
                    while (!stopped.WaitOne(0)) {
                        Packet packet = null;
                        lock (packets) {
                            if (packets.Count > 0) {
                                packet = packets.Dequeue();
                                queuedFrames -= packet.Frames;
                            }
                        }
                        if (packet == null) { WaitHandle.WaitAny(handles); continue; }
                        writer.Write(packet.Position);
                        writer.Write(packet.Frames);
                        writer.Write(packet.Data != null ? packet.Data.Length : 0);
                        if (packet.Data != null) writer.Write(packet.Data);
                    }
                }
            } catch (IOException) {
                stopped.Set();
            }
        }
    }

    [MTAThread]
    private static int Main(string[] args) {
        int processId;
        if (args.Length != 2 || !Int32.TryParse(args[0], out processId) || processId <= 0
            || (args[1] != "include" && args[1] != "exclude")) return 2;
        try {
            Capture(processId, args[1] == "include");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void Capture(int processId, bool includeProcessTree) {
        // A reader and a writer can still be unwinding when the executable exits.
        // These handles live for the lifetime of this single-command process.
        var stopped = new ManualResetEvent(false);
        new Thread(delegate() {
            try { Console.OpenStandardInput().ReadByte(); }
            catch (IOException) { }
            finally { stopped.Set(); }
        }) { IsBackground = true }.Start();

        using (var samplesReady = new AutoResetEvent(false)) {
            var client = Open(processId, includeProcessTree);
            object captureObject = null;
            try {
                var format = new WaveFormat {
                    Format = 1, Channels = 2, Rate = SampleRate, BytesPerSecond = SampleRate * FrameBytes,
                    BlockAlign = FrameBytes, Bits = 16
                };
                Marshal.ThrowExceptionForHR(client.Initialize(0, Loopback | EventCallback | AutoConvertPcm,
                    0, 0, ref format, IntPtr.Zero));
                Marshal.ThrowExceptionForHR(client.SetEventHandle(samplesReady.SafeWaitHandle.DangerousGetHandle()));
                Guid iid = typeof(IAudioCaptureClient).GUID;
                Marshal.ThrowExceptionForHR(client.GetService(ref iid, out captureObject));
                var capture = (IAudioCaptureClient)captureObject;
                Marshal.ThrowExceptionForHR(client.Start());
                try {
                    var output = new Output(stopped);
                    new Thread(output.Write) { IsBackground = true }.Start();
                    var handles = new WaitHandle[] { stopped, samplesReady };
                    var position = new SamplePosition();
                    while (WaitHandle.WaitAny(handles) == 1) Drain(capture, output, position, stopped);
                } finally { client.Stop(); }
            } finally {
                if (captureObject != null) Marshal.ReleaseComObject(captureObject);
                Marshal.ReleaseComObject(client);
            }
        }
    }

    private static void Drain(IAudioCaptureClient capture, Output output, SamplePosition position, ManualResetEvent stopped) {
        while (!stopped.WaitOne(0)) {
            uint size;
            Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out size));
            if (size == 0) return;

            IntPtr data;
            uint frames, flags;
            ulong devicePosition, counterPosition;
            Marshal.ThrowExceptionForHR(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out counterPosition));
            if (frames == 0) return;
            Packet packet;
            try {
                ulong start = position.Advance(devicePosition, frames, (flags & TimestampError) == 0);
                int keep = (int)Math.Min(frames, (uint)MaxQueuedFrames);
                int skip = checked((int)frames - keep);
                packet = new Packet { Position = start + (ulong)skip, Frames = keep };
                if ((flags & Silent) == 0 && data != IntPtr.Zero) {
                    packet.Data = new byte[keep * FrameBytes];
                    Marshal.Copy(IntPtr.Add(data, checked(skip * FrameBytes)), packet.Data, 0, packet.Data.Length);
                }
            } finally { Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames)); }
            output.Enqueue(packet);
        }
    }
}
