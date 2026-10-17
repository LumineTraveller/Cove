package com.oney.WebRTCModule;

import android.content.Context;
import android.content.ContextWrapper;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.*;
import com.facebook.react.bridge.*;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import java.util.*;

/** Screen audio/video use their own ADM and PC factory. Voice keeps its normal factory.
 * Factory/track operations run on react-native-webrtc's serial executor. */
public final class CoveScreenRuntime {
    private static volatile MediaProjection projection;
    private static PeerConnectionFactory factory;
    private static AudioSource source;
    private static AudioTrack track;
    private static volatile String session;
    private static volatile ReactApplicationContext reactContext;
    private static MediaProjection sessionProjection;
    private static CoveScreenEncoderFactory encoderFactory;
    private static boolean playbackFactory;
    private static final Set<PeerConnection> screenPeers = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final List<Runnable> releaseCallbacks = new ArrayList<>();
    private static final List<Runnable> transportClosedCallbacks = new ArrayList<>();
    private static boolean releaseRequested;
    private static final class ScreenConfiguration {
        final String sessionId;
        final int attemptId;
        ScreenConfiguration(String sessionId, int attemptId) { this.sessionId = sessionId; this.attemptId = attemptId; }
    }
    private static final Map<PeerConnection.RTCConfiguration, ScreenConfiguration> configs = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Set<AudioRecord> playbackRecords = Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));

    private static final class PlaybackContext extends ContextWrapper {
        final MediaProjection projection;
        PlaybackContext(Context base, MediaProjection projection) { super(base); this.projection = projection; }
    }
    public static void projectionStarted(MediaProjection value) {
        if (value == null) throw new IllegalStateException("屏幕采集授权已结束");
        projection = value;
        value.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { if (projection == value) projection = null; }
        }, new Handler(Looper.getMainLooper()));
    }
    public static boolean isPlaybackRecord(AudioRecord record) { return playbackRecords.contains(record); }

    public static AudioRecord createAudioRecord(int audioSource, int rate, int channels, int format, int size, Context context) {
        AudioRecord.Builder builder = new AudioRecord.Builder()
            .setAudioFormat(new AudioFormat.Builder().setEncoding(format).setSampleRate(rate).setChannelMask(channels).build())
            .setBufferSizeInBytes(size);
        if (context instanceof PlaybackContext) {
            if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("播放音频需要 Android 10 或更新版本");
            PlaybackContext playback = (PlaybackContext) context;
            if (projection != playback.projection) throw new IllegalStateException("屏幕采集授权已结束");
            AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(playback.projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                // Exclude Cove's call, soundboard and presence tones: no feedback loop.
                .excludeUid(android.os.Process.myUid()).build();
            AudioRecord record = builder.setAudioPlaybackCaptureConfig(config).build();
            playbackRecords.add(record);
            return record;
        }
        return builder.setAudioSource(audioSource).build();
    }
    public static void markConfiguration(PeerConnection.RTCConfiguration config, ReadableMap map) {
        if (map == null) return;
        if (map.hasKey("coveScreenVideo") && map.getType("coveScreenVideo") == ReadableType.String) {
            if (!map.hasKey("coveScreenVideoAttempt") || map.getType("coveScreenVideoAttempt") != ReadableType.Number
                    || map.getInt("coveScreenVideoAttempt") < 1)
                throw new IllegalArgumentException("屏幕共享通道缺少有效的尝试编号");
            configs.put(config, new ScreenConfiguration(map.getString("coveScreenVideo"), map.getInt("coveScreenVideoAttempt")));
        } else if (map.hasKey("coveScreenAudio") && map.getType("coveScreenAudio") == ReadableType.String) {
            configs.put(config, new ScreenConfiguration(map.getString("coveScreenAudio"), 0));
        }
    }
    public static PeerConnection createPeerConnection(PeerConnectionFactory normal, PeerConnection.RTCConfiguration config, PeerConnection.Observer observer) {
        ScreenConfiguration requested = configs.remove(config);
        if (requested == null) return normal.createPeerConnection(config, observer);
        if (!requested.sessionId.equals(session) || projection != sessionProjection || releaseRequested)
            throw new IllegalStateException("屏幕共享会话已结束");
        if (!screenPeers.isEmpty()) throw new IllegalStateException("请先释放上一次屏幕共享通道");
        encoderFactory.setListener(encoderListener(requested.sessionId, requested.attemptId));
        ensureFactory(false);
        PeerConnection peer = factory.createPeerConnection(config, observer);
        if (peer != null) screenPeers.add(peer);
        return peer;
    }
    public static void peerConnectionDisposed(PeerConnection peer) {
        if (screenPeers.remove(peer)) {
            notifyTransportClosed();
            finishRelease();
        }
    }
    public static MediaStreamTrack localTrack(MediaStreamTrack normal, String id) {
        return normal != null ? normal : track != null && track.id().equals(id) ? track : null;
    }
    private static void audioError(String expectedSession, String message) {
        ReactApplicationContext context = reactContext;
        if (!expectedSession.equals(session) || context == null || !context.hasActiveReactInstance()) return;
        WritableMap data = Arguments.createMap();
        data.putString("sessionId", expectedSession);
        data.putString("message", message);
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("CoveScreenAudioError", data);
    }
    static WritableMap encoderCapabilities(ReactApplicationContext context) {
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null) throw new IllegalStateException("WebRTC 尚未初始化");
        CoveScreenEncoderFactory.Capabilities capabilities = CoveScreenEncoderFactory.inspect(module.mVideoEncoderFactory);
        WritableMap data = Arguments.createMap();
        data.putBoolean("h264Hardware", capabilities.h264HardwareProfiles.length > 0);
        WritableArray profiles = Arguments.createArray();
        for (String profile : capabilities.h264HardwareProfiles) profiles.pushString(profile);
        data.putArray("h264HardwareProfiles", profiles);
        WritableArray codecs = Arguments.createArray();
        for (String codec : capabilities.codecs) codecs.pushString(codec);
        data.putArray("codecs", codecs);
        return data;
    }
    static WritableMap prepareVideo(ReactApplicationContext context) {
        MediaProjection approved = projection;
        if (approved == null) throw new IllegalStateException("请先授权共享屏幕");
        if (session != null) throw new IllegalStateException("屏幕共享正在使用中");
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null) throw new IllegalStateException("WebRTC 尚未初始化");
        reactContext = context;
        session = UUID.randomUUID().toString();
        sessionProjection = approved;
        encoderFactory = new CoveScreenEncoderFactory(module.mVideoEncoderFactory, null);
        WritableMap result = Arguments.createMap();
        result.putString("sessionId", session);
        return result;
    }
    private static CoveScreenEncoderFactory.Listener encoderListener(final String preparedSession, final int attemptId) {
        return new CoveScreenEncoderFactory.Listener() {
            @Override public void onReady(String codec, String implementation, boolean hardwareAccelerated,
                                          int width, int height, int encoderMaxFramerate) {
                WritableMap data = encoderEvent(preparedSession, attemptId, codec);
                data.putString("implementation", implementation);
                data.putBoolean("hardwareAccelerated", hardwareAccelerated);
                data.putInt("width", width);
                data.putInt("height", height);
                data.putInt("targetFps", CoveScreenVideoSource.TARGET_FPS);
                data.putInt("encoderMaxFramerate", encoderMaxFramerate);
                emitEncoderEvent(preparedSession, "CoveScreenEncoderReady", data);
            }
            @Override public void onError(String codec, String stage, String reason, String code) {
                WritableMap data = encoderEvent(preparedSession, attemptId, codec);
                data.putString("stage", stage);
                data.putString("reason", reason);
                data.putString("code", code);
                emitEncoderEvent(preparedSession, "CoveScreenEncoderError", data);
            }
        };
    }
    private static WritableMap encoderEvent(String expectedSession, int attemptId, String codec) {
        WritableMap data = Arguments.createMap();
        data.putString("sessionId", expectedSession);
        data.putInt("attemptId", attemptId);
        data.putString("codec", codec);
        return data;
    }
    private static void emitEncoderEvent(String expectedSession, String event, WritableMap data) {
        ReactApplicationContext context = reactContext;
        if (!expectedSession.equals(session) || context == null || !context.hasActiveReactInstance()) return;
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(event, data);
    }
    private static void ensureFactory(boolean withPlayback) {
        if (factory != null) {
            if (withPlayback && !playbackFactory) throw new IllegalStateException("播放音频必须在共享通道前准备");
            return;
        }
        ReactApplicationContext context = reactContext;
        if (context == null || session == null || projection != sessionProjection || releaseRequested)
            throw new IllegalStateException("屏幕共享会话已结束");
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null) throw new IllegalStateException("WebRTC 尚未初始化");
        final String audioSession = session;
        JavaAudioDeviceModule.Builder builder = JavaAudioDeviceModule.builder(
            withPlayback ? new PlaybackContext(context, sessionProjection) : context).setEnableVolumeLogger(false);
        if (withPlayback) builder
            .setInputSampleRate(48_000).setUseStereoInput(true).setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
            .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false)
            .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                @Override public void onWebRtcAudioRecordInitError(String error) { audioError(audioSession, error); }
                @Override public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode code, String error) { audioError(audioSession, error); }
                @Override public void onWebRtcAudioRecordError(String error) { audioError(audioSession, error); }
            });
        JavaAudioDeviceModule adm = builder.createAudioDeviceModule();
        try {
            factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm)
                .setVideoEncoderFactory(encoderFactory).setVideoDecoderFactory(module.mVideoDecoderFactory)
                .createPeerConnectionFactory();
            playbackFactory = withPlayback;
        } finally { adm.release(); }
    }
    static WritableMap prepareAudio(ReactApplicationContext context, String expectedSession) {
        if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("播放音频需要 Android 10 或更新版本");
        if (expectedSession == null || !expectedSession.equals(session)) throw new IllegalStateException("屏幕共享会话已结束");
        if (track != null) throw new IllegalStateException("播放音频正在使用中");
        ensureFactory(true);
        MediaConstraints constraints = new MediaConstraints();
        for (String key : new String[]{"googEchoCancellation", "googNoiseSuppression", "googNoiseSuppression2", "googAutoGainControl", "googAutoGainControl2", "googHighpassFilter"})
            constraints.mandatory.add(new MediaConstraints.KeyValuePair(key, "false"));
        source = factory.createAudioSource(constraints);
        track = factory.createAudioTrack(session, source);
        final WritableMap[] result = new WritableMap[1];
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        module.createStream(new MediaStreamTrack[]{track}, (streamId, info) -> {
            WritableMap data = Arguments.createMap();
            data.putString("streamId", streamId);
            data.putString("streamReactTag", streamId);
            data.putString("sessionId", session);
            WritableArray tracks = Arguments.createArray();
            for (WritableMap item : info) tracks.pushMap(item);
            data.putArray("tracks", tracks);
            result[0] = data;
        });
        return result[0];
    }
    static void waitForTransportClosed(String expectedSession, Runnable completed) {
        if (expectedSession == null || !expectedSession.equals(session) || screenPeers.isEmpty()) {
            completed.run(); return;
        }
        transportClosedCallbacks.add(completed);
    }
    private static void notifyTransportClosed() {
        if (!screenPeers.isEmpty()) return;
        List<Runnable> callbacks = new ArrayList<>(transportClosedCallbacks);
        transportClosedCallbacks.clear();
        for (Runnable callback : callbacks) callback.run();
    }
    static void releaseVideo(String expectedSession, Runnable completed) {
        if (expectedSession != null && !expectedSession.equals(session)) { completed.run(); return; }
        releaseCallbacks.add(completed);
        releaseRequested = true;
        finishRelease();
    }
    private static void finishRelease() {
        // RN close() closes signaling. Its JS closed event later invokes native dispose().
        // Keep the factory, ADM and audio track alive until every screen PC is disposed.
        if (!releaseRequested || !screenPeers.isEmpty()) return;
        if (track != null) { track.dispose(); track = null; }
        if (source != null) { source.dispose(); source = null; }
        if (factory != null) { factory.dispose(); factory = null; }
        playbackRecords.clear();
        encoderFactory = null;
        sessionProjection = null;
        playbackFactory = false;
        notifyTransportClosed();
        session = null;
        reactContext = null;
        releaseRequested = false;
        List<Runnable> callbacks = new ArrayList<>(releaseCallbacks);
        releaseCallbacks.clear();
        for (Runnable callback : callbacks) callback.run();
    }
}
