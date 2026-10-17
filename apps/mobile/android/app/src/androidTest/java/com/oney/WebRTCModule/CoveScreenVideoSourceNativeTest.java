package com.oney.WebRTCModule;

import android.content.Context;
import java.util.HashSet;
import java.util.Set;
import org.webrtc.CapturerObserver;
import org.webrtc.JavaI420Buffer;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

/** Real WebRTC source test using generated pixels only; no capture device or projection. */
public final class CoveScreenVideoSourceNativeTest {
    private static final int INPUT_FPS = 60;
    private static final int INPUT_FRAMES = 120;
    private static final long SECOND_NS = 1_000_000_000L;
    private static final int[][] FORMATS = {
        {640, 360, 0}, {480, 270, 0}, {320, 180, 0},
        {360, 640, 90}, {270, 480, 270}, {180, 320, 180}
    };

    private CoveScreenVideoSourceNativeTest() {}

    /** Called explicitly by the isolated instrumentation runner's screenSource suite. */
    public static String run(Context context) throws InterruptedException {
        require("com.cove.mobile.refactor".equals(context.getPackageName()), "Requires isolated debug package");
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context)
            .createInitializationOptions());
        PeerConnectionFactory factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
        VideoSource screenSource = null, cameraSource = null;
        VideoTrack screenTrack = null, cameraTrack = null;
        CapturerObserver screenObserver = null, cameraObserver = null;
        Probe screen = new Probe("screen"), camera = new Probe("camera");
        try {
            screenSource = CoveScreenVideoSource.createVideoSource(factory, true);
            cameraSource = CoveScreenVideoSource.createVideoSource(factory, false);
            screenTrack = factory.createVideoTrack("synthetic-screen-source", screenSource);
            cameraTrack = factory.createVideoTrack("synthetic-camera-source", cameraSource);
            screenTrack.addSink(screen);
            cameraTrack.addSink(camera);
            screenObserver = screenSource.getCapturerObserver();
            cameraObserver = cameraSource.getCapturerObserver();
            screenObserver.onCapturerStarted(true);
            cameraObserver.onCapturerStarted(true);

            long startNs = System.nanoTime();
            for (int index = 0; index < INPUT_FRAMES; index++) {
                long timestampNs = startNs + index * SECOND_NS / INPUT_FPS;
                sleepUntil(timestampNs);
                int formatIndex = index / (INPUT_FRAMES / FORMATS.length);
                int[] format = FORMATS[formatIndex];
                JavaI420Buffer buffer = JavaI420Buffer.allocate(format[0], format[1]);
                // A pixel marker identifies the expected input even if delivery crosses threads.
                buffer.getDataY().put(0, (byte) (formatIndex + 1));
                VideoFrame frame = new VideoFrame(buffer, format[2], timestampNs);
                try {
                    screenObserver.onFrameCaptured(frame);
                    cameraObserver.onFrameCaptured(frame);
                } finally {
                    frame.release();
                }
            }
            screen.verify(INPUT_FRAMES / 2 - 3, INPUT_FRAMES / 2 + 3);
            camera.verify(INPUT_FRAMES, INPUT_FRAMES);
            return "PASS: real WebRTC 124 source: screen " + screen.count() + "/120, camera " + camera.count()
                + "/120 at 60fps input; six scale/orientation formats preserved; synthetic pixels only.\n";
        } finally {
            if (screenObserver != null) screenObserver.onCapturerStopped();
            if (cameraObserver != null) cameraObserver.onCapturerStopped();
            if (screenTrack != null) { screenTrack.removeSink(screen); screenTrack.dispose(); }
            if (cameraTrack != null) { cameraTrack.removeSink(camera); cameraTrack.dispose(); }
            if (screenSource != null) screenSource.dispose();
            if (cameraSource != null) cameraSource.dispose();
            factory.dispose();
        }
    }

    private static void sleepUntil(long deadlineNs) throws InterruptedException {
        long remaining;
        while ((remaining = deadlineNs - System.nanoTime()) > 0) {
            Thread.sleep(remaining / 1_000_000L, (int) (remaining % 1_000_000L));
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class Probe implements VideoSink {
        private final String label;
        private final Set<Integer> formatsSeen = new HashSet<>();
        private int frames;
        private long previousTimestampNs = Long.MIN_VALUE;
        private String failure;

        Probe(String label) { this.label = label; }

        @Override public synchronized void onFrame(VideoFrame frame) {
            // Do not throw across the native-to-Java callback boundary.
            try {
                VideoFrame.I420Buffer pixels = frame.getBuffer().toI420();
                int marker;
                try { marker = pixels.getDataY().get(0) & 0xff; }
                finally { pixels.release(); }
                require(marker >= 1 && marker <= FORMATS.length, "Unexpected or cropped pixel marker: " + marker);
                int[] expected = FORMATS[marker - 1];
                require(frame.getBuffer().getWidth() == expected[0] && frame.getBuffer().getHeight() == expected[1],
                    "Source changed input dimensions for format " + marker);
                require(frame.getRotation() == expected[2], "Source changed rotation for format " + marker);
                require(frame.getTimestampNs() > previousTimestampNs, "Source timestamps did not advance");
                previousTimestampNs = frame.getTimestampNs();
                formatsSeen.add(marker);
                frames++;
            } catch (Throwable error) {
                if (failure == null) failure = label + ": " + error;
            }
        }

        synchronized int count() { return frames; }

        synchronized void verify(int minimum, int maximum) {
            require(failure == null, failure);
            require(frames >= minimum && frames <= maximum, label + " delivered " + frames + " frames; expected " + minimum + ".." + maximum);
            require(formatsSeen.size() == FORMATS.length, label + " did not deliver every scale/orientation format");
        }
    }
}
