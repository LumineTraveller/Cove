package com.oney.WebRTCModule;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import org.webrtc.VideoCodecInfo;
import org.webrtc.VideoCodecStatus;
import org.webrtc.VideoEncoder;
import org.webrtc.VideoEncoderFactory;
import org.webrtc.VideoFrame;
import org.webrtc.WrappedNativeVideoEncoder;

/** Observes the screen factory only. A different codec always requires renegotiation in JS. */
public final class CoveScreenEncoderFactory implements VideoEncoderFactory {
    public interface Listener {
        void onReady(String codec, String implementation, boolean hardwareAccelerated,
                     int width, int height, int encoderMaxFramerate);
        void onError(String codec, String stage, String reason, String code);
    }

    public static final class Capabilities {
        public final String[] codecs;
        public final String[] h264HardwareProfiles;
        Capabilities(Set<String> codecs, Set<String> profiles) {
            this.codecs = codecs.toArray(new String[0]);
            this.h264HardwareProfiles = profiles.toArray(new String[0]);
        }
    }

    private final VideoEncoderFactory delegate;
    private volatile Listener listener;

    public CoveScreenEncoderFactory(VideoEncoderFactory delegate, Listener listener) {
        this.delegate = delegate;
        this.listener = listener;
    }
    // Called only after the previous screen PC's native dispose completes.
    void setListener(Listener listener) { this.listener = listener; }

    /** Creating an encoder proves availability, not that MediaCodec.initEncode will succeed. */
    public static Capabilities inspect(VideoEncoderFactory factory) {
        Set<String> codecs = new LinkedHashSet<>();
        Set<String> profiles = new LinkedHashSet<>();
        for (VideoCodecInfo info : factory.getSupportedCodecs()) {
            codecs.add(info.name.toLowerCase(Locale.ROOT));
            if (!info.name.equalsIgnoreCase("H264")) continue;
            VideoEncoder probe = null;
            try {
                probe = factory.createEncoder(info);
                String profile = info.params.get(VideoCodecInfo.H264_FMTP_PROFILE_LEVEL_ID);
                if (probe != null && !(probe instanceof WrappedNativeVideoEncoder)
                        && probe.isHardwareEncoder() && profile != null) {
                    profiles.add(profile.toLowerCase(Locale.ROOT));
                }
            } catch (RuntimeException ignored) {
                // A broken advertised encoder must not prevent choosing another codec.
            } finally {
                // WrappedNativeVideoEncoder allocates on createNative; its Java release throws.
                if (probe != null && !(probe instanceof WrappedNativeVideoEncoder)) {
                    try { probe.release(); } catch (RuntimeException ignored) { }
                }
            }
        }
        return new Capabilities(codecs, profiles);
    }

    @Override public VideoCodecInfo[] getSupportedCodecs() { return delegate.getSupportedCodecs(); }
    @Override public VideoCodecInfo[] getImplementations() { return delegate.getImplementations(); }
    @Override public VideoEncoderSelector getEncoderSelector() { return delegate.getEncoderSelector(); }

    @Override public VideoEncoder createEncoder(VideoCodecInfo info) {
        final Listener attemptListener = listener;
        final VideoEncoder encoder;
        try { encoder = delegate.createEncoder(info); }
        catch (RuntimeException error) {
            error(attemptListener, info.name, "create", "exception", error.getClass().getSimpleName());
            return null;
        }
        if (encoder == null) {
            error(attemptListener, info.name, "create", "unavailable", "NOT_CREATED");
            return null;
        }
        // VP8/VP9/AV1 use native wrappers. Passing them through preserves their native handle;
        // invoking their final Java initEncode/encode methods would throw.
        if (!info.name.equalsIgnoreCase("H264") || encoder instanceof WrappedNativeVideoEncoder) return encoder;
        return new ObservedEncoder(info.name, encoder, attemptListener);
    }

    private static void error(Listener listener, String codec, String stage, String reason, String code) {
        if (listener == null) return;
        try { listener.onError(codec, stage, reason, code); } catch (RuntimeException ignored) { }
    }

    private final class ObservedEncoder implements VideoEncoder {
        private final String codec;
        private final VideoEncoder encoder;
        private final Listener attemptListener;
        private boolean failureReported;
        ObservedEncoder(String codec, VideoEncoder encoder, Listener attemptListener) {
            this.codec = codec; this.encoder = encoder; this.attemptListener = attemptListener;
        }
        private void failure(String stage, String reason, String code) {
            if (failureReported) return;
            failureReported = true;
            error(attemptListener, codec, stage, reason, code);
        }
        private VideoCodecStatus status(String stage, VideoCodecStatus status) {
            if (status == null) {
                failure(stage, "status", "NULL_STATUS");
                return VideoCodecStatus.ERROR;
            }
            if (status != VideoCodecStatus.NO_OUTPUT && status.getNumber() < 0)
                failure(stage, "status", status.name());
            return status;
        }
        @Override public VideoCodecStatus initEncode(Settings settings, Callback callback) {
            try {
                VideoCodecStatus result = status("init", encoder.initEncode(settings, callback));
                if (result != VideoCodecStatus.OK) failure("init", "status", result.name());
                if (result == VideoCodecStatus.OK) {
                    try {
                        if (attemptListener != null) attemptListener.onReady(codec, encoder.getImplementationName(), encoder.isHardwareEncoder(),
                            settings.width, settings.height, settings.maxFramerate);
                    } catch (RuntimeException ignored) { }
                }
                return result;
            } catch (RuntimeException error) {
                failure("init", "exception", error.getClass().getSimpleName());
                return VideoCodecStatus.ERROR;
            }
        }
        @Override public VideoCodecStatus encode(VideoFrame frame, EncodeInfo info) {
            try { return status("encode", encoder.encode(frame, info)); }
            catch (RuntimeException error) {
                failure("encode", "exception", error.getClass().getSimpleName());
                return VideoCodecStatus.ERROR;
            }
        }
        @Override public VideoCodecStatus release() { return encoder.release(); }
        @Override public boolean isHardwareEncoder() { return encoder.isHardwareEncoder(); }
        @Override public VideoCodecStatus setRateAllocation(BitrateAllocation allocation, int framerate) {
            return encoder.setRateAllocation(allocation, framerate);
        }
        @Override public VideoCodecStatus setRates(RateControlParameters parameters) { return encoder.setRates(parameters); }
        @Override public ScalingSettings getScalingSettings() { return encoder.getScalingSettings(); }
        @Override public ResolutionBitrateLimits[] getResolutionBitrateLimits() { return encoder.getResolutionBitrateLimits(); }
        @Override public String getImplementationName() { return encoder.getImplementationName(); }
        @Override public EncoderInfo getEncoderInfo() { return encoder.getEncoderInfo(); }
    }
}
