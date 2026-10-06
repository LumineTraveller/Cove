package com.oney.WebRTCModule;
import com.facebook.react.bridge.*;

public final class CoveScreenModule extends ReactContextBaseJavaModule {
    public CoveScreenModule(ReactApplicationContext context) { super(context); }
    @Override public String getName() { return "CoveScreen"; }
    @ReactMethod public void createPlaybackAudio(Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { promise.resolve(CoveScreenRuntime.prepareAudio(getReactApplicationContext())); }
            catch (Exception error) {
                CoveScreenRuntime.releaseAudio(null, () -> {});
                promise.reject("SCREEN_AUDIO", error.getMessage(), error);
            }
        });
    }
    @ReactMethod public void releasePlaybackAudio(String sessionId, Promise promise) {
        ThreadUtils.runOnExecutor(() -> {
            try { CoveScreenRuntime.releaseAudio(sessionId, () -> promise.resolve(null)); }
            catch (Exception error) { promise.reject("SCREEN_AUDIO", error.getMessage(), error); }
        });
    }
}
