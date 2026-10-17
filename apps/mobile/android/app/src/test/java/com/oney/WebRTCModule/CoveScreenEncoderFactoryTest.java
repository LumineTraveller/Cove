package com.oney.WebRTCModule;

import java.util.*;
import org.junit.Test;
import org.webrtc.*;
import static org.junit.Assert.*;

public class CoveScreenEncoderFactoryTest {
    private static final VideoCodecInfo H264 = new VideoCodecInfo("H264", Collections.singletonMap("profile-level-id", "42e01f"));
    private static final VideoCodecInfo VP8 = new VideoCodecInfo("VP8", Collections.emptyMap());
    private static final VideoEncoder.Settings SETTINGS = new VideoEncoder.Settings(4, 1080, 2400, 2500, 30, 1, false);

    private static final class Events implements CoveScreenEncoderFactory.Listener {
        final List<String> errors = new ArrayList<>();
        final List<String> ready = new ArrayList<>();
        @Override public void onError(String codec, String stage, String reason, String code) {
            errors.add(codec + ":" + stage + ":" + reason + ":" + code);
        }
        @Override public void onReady(String codec, String implementation, boolean hardware, int width, int height, int fps) {
            ready.add(codec + ":" + implementation + ":" + hardware + ":" + width + "x" + height + ":" + fps);
        }
    }
    private static class Encoder implements VideoEncoder {
        VideoCodecStatus initStatus = VideoCodecStatus.OK;
        VideoCodecStatus encodeStatus = VideoCodecStatus.OK;
        RuntimeException initException;
        RuntimeException encodeException;
        Settings settings;
        int released;
        boolean hardware = true;
        final EncoderInfo info = new EncoderInfo(2, true);
        @Override public VideoCodecStatus initEncode(Settings settings, Callback callback) {
            this.settings = settings;
            if (initException != null) throw initException;
            return initStatus;
        }
        @Override public VideoCodecStatus encode(VideoFrame frame, EncodeInfo encodeInfo) {
            if (encodeException != null) throw encodeException;
            return encodeStatus;
        }
        @Override public VideoCodecStatus release() { released++; return VideoCodecStatus.OK; }
        @Override public boolean isHardwareEncoder() { return hardware; }
        @Override public VideoCodecStatus setRateAllocation(BitrateAllocation allocation, int framerate) { return VideoCodecStatus.OK; }
        @Override public ScalingSettings getScalingSettings() { return ScalingSettings.OFF; }
        @Override public String getImplementationName() { return "c2.vendor.avc.encoder"; }
        @Override public EncoderInfo getEncoderInfo() { return info; }
    }
    private static class Factory implements VideoEncoderFactory {
        final VideoCodecInfo[] codecs;
        VideoEncoder encoder;
        RuntimeException exception;
        Factory(VideoEncoder encoder, VideoCodecInfo... codecs) { this.encoder = encoder; this.codecs = codecs; }
        @Override public VideoEncoder createEncoder(VideoCodecInfo info) {
            if (exception != null) throw exception;
            return encoder;
        }
        @Override public VideoCodecInfo[] getSupportedCodecs() { return codecs; }
    }

    @Test public void capabilityRequiresAnActuallyCreatedHardwareH264ProfileAndReleasesTheProbe() {
        Encoder encoder = new Encoder();
        CoveScreenEncoderFactory.Capabilities caps = CoveScreenEncoderFactory.inspect(new Factory(encoder, H264, VP8));
        assertArrayEquals(new String[]{"h264", "vp8"}, caps.codecs);
        assertArrayEquals(new String[]{"42e01f"}, caps.h264HardwareProfiles);
        assertEquals(1, encoder.released);
        assertNull("Availability probing must not initialize a codec", encoder.settings);
        encoder.hardware = false;
        assertEquals(0, CoveScreenEncoderFactory.inspect(new Factory(encoder, H264)).h264HardwareProfiles.length);
        assertEquals(0, CoveScreenEncoderFactory.inspect(new Factory(null, H264)).h264HardwareProfiles.length);
    }

    @Test public void failedAdvertisedCapabilityDoesNotBlockTheOtherCodecs() {
        Factory delegate = new Factory(null, H264, VP8);
        delegate.exception = new IllegalStateException("sensitive device detail");
        CoveScreenEncoderFactory.Capabilities caps = CoveScreenEncoderFactory.inspect(delegate);
        assertArrayEquals(new String[]{"h264", "vp8"}, caps.codecs);
        assertEquals(0, caps.h264HardwareProfiles.length);
    }

    @Test public void createNullOrExceptionIsReportedWithoutChangingTheNegotiatedCodec() {
        Events events = new Events();
        Factory delegate = new Factory(null, H264);
        CoveScreenEncoderFactory factory = new CoveScreenEncoderFactory(delegate, events);
        assertNull(factory.createEncoder(H264));
        assertEquals("H264:create:unavailable:NOT_CREATED", events.errors.get(0));
        delegate.exception = new IllegalStateException("must not reach JS or diagnostics");
        assertNull(factory.createEncoder(H264));
        assertEquals("H264:create:exception:IllegalStateException", events.errors.get(1));
        assertTrue(events.ready.isEmpty());
    }

    @Test public void initSuccessReportsActualImplementationAndForwardsOriginalDimensionsAndFps() {
        Encoder encoder = new Encoder();
        Events events = new Events();
        VideoEncoder observed = new CoveScreenEncoderFactory(new Factory(encoder, H264), events).createEncoder(H264);
        assertTrue(events.ready.isEmpty());
        assertEquals(VideoCodecStatus.OK, observed.initEncode(SETTINGS, null));
        assertSame(SETTINGS, encoder.settings);
        assertEquals("H264:c2.vendor.avc.encoder:true:1080x2400:30", events.ready.get(0));
        assertSame(encoder.info, observed.getEncoderInfo());
        assertSame(VideoEncoder.ScalingSettings.OFF, observed.getScalingSettings());
        assertEquals(VideoCodecStatus.OK, observed.release());
        assertEquals(1, encoder.released);
    }

    @Test public void nativeSoftwareEncoderIsReturnedIntactAndIsNeverProbedThroughJavaRelease() {
        WrappedNativeVideoEncoder nativeEncoder = new WrappedNativeVideoEncoder() {
            @Override public boolean isHardwareEncoder() { return false; }
            @Override public long createNativeVideoEncoder() { return 99L; }
        };
        Events events = new Events();
        CoveScreenEncoderFactory factory = new CoveScreenEncoderFactory(new Factory(nativeEncoder, VP8), events);
        assertSame(nativeEncoder, factory.createEncoder(VP8));
        assertTrue(events.ready.isEmpty());
        assertTrue(events.errors.isEmpty());
        assertEquals(0, CoveScreenEncoderFactory.inspect(new Factory(nativeEncoder, H264)).h264HardwareProfiles.length);
    }

    @Test public void initFailureEmitsOnlyOneFailureAndNeverEmitsReady() {
        Encoder encoder = new Encoder();
        encoder.initStatus = VideoCodecStatus.ERR_SIZE;
        Events events = new Events();
        VideoEncoder observed = new CoveScreenEncoderFactory(new Factory(encoder, H264), events).createEncoder(H264);
        assertEquals(VideoCodecStatus.ERR_SIZE, observed.initEncode(SETTINGS, null));
        assertEquals(VideoCodecStatus.ERR_SIZE, observed.initEncode(SETTINGS, null));
        assertEquals(Collections.singletonList("H264:init:status:ERR_SIZE"), events.errors);
        assertTrue(events.ready.isEmpty());
    }

    @Test public void unexpectedInitStatusAndExceptionsAlsoTriggerRenegotiation() {
        Encoder encoder = new Encoder();
        encoder.initStatus = VideoCodecStatus.NO_OUTPUT;
        Events events = new Events();
        VideoEncoder observed = new CoveScreenEncoderFactory(new Factory(encoder, H264), events).createEncoder(H264);
        observed.initEncode(SETTINGS, null);
        assertEquals(Collections.singletonList("H264:init:status:NO_OUTPUT"), events.errors);
        encoder.initException = new IllegalArgumentException("private exception detail");
        events = new Events();
        observed = new CoveScreenEncoderFactory(new Factory(encoder, H264), events).createEncoder(H264);
        assertEquals(VideoCodecStatus.ERROR, observed.initEncode(SETTINGS, null));
        assertEquals(Collections.singletonList("H264:init:exception:IllegalArgumentException"), events.errors);
    }

    @Test public void ordinaryNoOutputDoesNotFallbackButFatalEncodeStatusDoesOnlyOnce() {
        Encoder encoder = new Encoder();
        Events events = new Events();
        VideoEncoder observed = new CoveScreenEncoderFactory(new Factory(encoder, H264), events).createEncoder(H264);
        observed.initEncode(SETTINGS, null);
        encoder.encodeStatus = VideoCodecStatus.NO_OUTPUT;
        assertEquals(VideoCodecStatus.NO_OUTPUT, observed.encode(null, null));
        assertTrue(events.errors.isEmpty());
        encoder.encodeStatus = VideoCodecStatus.FALLBACK_SOFTWARE;
        assertEquals(VideoCodecStatus.FALLBACK_SOFTWARE, observed.encode(null, null));
        observed.encode(null, null);
        assertEquals(Collections.singletonList("H264:encode:status:FALLBACK_SOFTWARE"), events.errors);
    }

    @Test public void oldEncoderKeepsItsAttemptListenerAfterAnotherTransportStarts() {
        Encoder encoder = new Encoder();
        Events firstAttempt = new Events();
        Events secondAttempt = new Events();
        CoveScreenEncoderFactory factory = new CoveScreenEncoderFactory(new Factory(encoder, H264), firstAttempt);
        VideoEncoder oldEncoder = factory.createEncoder(H264);
        factory.setListener(secondAttempt);
        oldEncoder.initEncode(SETTINGS, null);
        encoder.encodeStatus = VideoCodecStatus.FALLBACK_SOFTWARE;
        oldEncoder.encode(null, null);
        assertEquals(1, firstAttempt.ready.size());
        assertEquals(1, firstAttempt.errors.size());
        assertTrue(secondAttempt.ready.isEmpty());
        assertTrue(secondAttempt.errors.isEmpty());
        VideoEncoder current = factory.createEncoder(H264);
        current.initEncode(SETTINGS, null);
        assertEquals(1, secondAttempt.ready.size());
    }
}
