package com.oney.WebRTCModule;

import org.webrtc.PeerConnectionFactory;
import org.webrtc.VideoSource;

/** Source adaptation for screen capture; ownership stays with RN's TrackPrivate. */
public final class CoveScreenVideoSource {
    public static final int TARGET_FPS = 30;

    private CoveScreenVideoSource() {}

    public static VideoSource createVideoSource(PeerConnectionFactory factory, boolean isScreencast) {
        VideoSource source = factory.createVideoSource(isScreencast);
        if (isScreencast) {
            try {
                // Undefined ratios and absent pixel limits preserve capture scaling and rotation.
                // ScreenCapturerAndroid ignores startCapture's fps argument in WebRTC 124.
                source.adaptOutputFormat(
                    VideoSource.AspectRatio.UNDEFINED, null,
                    VideoSource.AspectRatio.UNDEFINED, null, TARGET_FPS);
            } catch (RuntimeException | Error failure) {
                source.dispose();
                throw failure;
            }
        }
        return source;
    }
}
