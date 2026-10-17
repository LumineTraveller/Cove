package com.oney.WebRTCModule;
import com.facebook.react.bridge.*;

public final class CoveScreenModule extends ReactContextBaseJavaModule {
    public CoveScreenModule(ReactApplicationContext context) { super(context); }
    @Override public String getName() { return "CoveScreen"; }
    @ReactMethod public void getScreenEncoderCapabilities(Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { promise.resolve(CoveScreenRuntime.encoderCapabilities(getReactApplicationContext())); }
            catch (Exception error) { promise.reject("SCREEN_ENCODER", error.getMessage(), error); }
        });
    }
    @ReactMethod public void prepareScreenVideo(Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { promise.resolve(CoveScreenRuntime.prepareVideo(getReactApplicationContext())); }
            catch (Exception error) { promise.reject("SCREEN_VIDEO", error.getMessage(), error); }
        });
    }
    @ReactMethod public void createPlaybackAudio(String sessionId, Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { promise.resolve(CoveScreenRuntime.prepareAudio(getReactApplicationContext(), sessionId)); }
            catch (Exception error) {
                CoveScreenRuntime.releaseVideo(sessionId, () -> {});
                promise.reject("SCREEN_AUDIO", error.getMessage(), error);
            }
        });
    }
    @ReactMethod public void releasePlaybackAudio(String sessionId, Promise promise) {
        releaseScreenVideo(sessionId, promise);
    }
    @ReactMethod public void waitForScreenTransportClosed(String sessionId, Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { CoveScreenRuntime.waitForTransportClosed(sessionId, () -> promise.resolve(null)); }
            catch (Exception error) { promise.reject("SCREEN_VIDEO", error.getMessage(), error); }
        });
    }
    @ReactMethod public void releaseScreenVideo(String sessionId, Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { CoveScreenRuntime.releaseVideo(sessionId, () -> promise.resolve(null)); }
            catch (Exception error) { promise.reject("SCREEN_VIDEO", error.getMessage(), error); }
        });
    }
}
