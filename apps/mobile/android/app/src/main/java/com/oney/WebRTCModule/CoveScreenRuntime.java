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

/** Playback uses its own ADM and PC factory. The voice factory/route/NS remain untouched.
 * Factory/track operations run on react-native-webrtc's serial executor. */
public final class CoveScreenRuntime {
    private static volatile MediaProjection projection;
    private static PeerConnectionFactory factory;
    private static AudioSource source;
    private static AudioTrack track;
    private static String session;
    private static ReactApplicationContext reactContext;
    private static final Set<PeerConnection> screenPeers = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final List<Runnable> releaseCallbacks = new ArrayList<>();
    private static boolean releaseRequested;
    private static final Map<PeerConnection.RTCConfiguration, String> configs = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Set<AudioRecord> playbackRecords = Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));

    private static final class PlaybackContext extends ContextWrapper {
        final MediaProjection projection;
        PlaybackContext(Context base, MediaProjection projection) { super(base); this.projection = projection; }
    }
    public static void projectionStarted(MediaProjection value) {
        if (value == null) throw new IllegalStateException("屏幕采集授权不可用");
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
            if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("共享音频需要 Android 10 或更新版本");
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
        // Identical to WebRTC 124's default microphone builder.
        return builder.setAudioSource(audioSource).build();
    }
    public static void markConfiguration(PeerConnection.RTCConfiguration config, ReadableMap map) {
        if (map != null && map.hasKey("coveScreenAudio") && map.getType("coveScreenAudio") == ReadableType.String) {
            configs.put(config, map.getString("coveScreenAudio"));
        }
    }
    public static PeerConnection createPeerConnection(PeerConnectionFactory normal, PeerConnection.RTCConfiguration config, PeerConnection.Observer observer) {
        String requested = configs.remove(config);
        if (requested == null) return normal.createPeerConnection(config, observer);
        if (factory == null || !requested.equals(session) || projection == null) {
            throw new IllegalStateException("共享音频会话已结束");
        }
        PeerConnection peer = factory.createPeerConnection(config, observer);
        if (peer != null) screenPeers.add(peer);
        return peer;
    }
    public static void peerConnectionDisposed(PeerConnection peer) {
        if (screenPeers.remove(peer)) finishRelease();
    }
    public static MediaStreamTrack localTrack(MediaStreamTrack normal, String id) {
        return normal != null ? normal : track != null && track.id().equals(id) ? track : null;
    }
    private static void audioError(String message) {
        ReactApplicationContext context = reactContext;
        if (context == null || !context.hasActiveReactInstance()) return;
        WritableMap data = Arguments.createMap();
        data.putString("sessionId", session);
        data.putString("message", message);
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("CoveScreenAudioError", data);
    }
    static WritableMap prepareAudio(ReactApplicationContext context) {
        if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("共享音频需要 Android 10 或更新版本");
        MediaProjection approved = projection;
        if (approved == null) throw new IllegalStateException("请先授权共享屏幕");
        if (factory != null) throw new IllegalStateException("共享音频仍在使用中");
        reactContext = context;
        session = UUID.randomUUID().toString();
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null) throw new IllegalStateException("WebRTC 尚未初始化");
        JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(new PlaybackContext(context, approved))
            .setInputSampleRate(48_000).setUseStereoInput(true).setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
            .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false).setEnableVolumeLogger(false)
            .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                @Override public void onWebRtcAudioRecordInitError(String error) { audioError(error); }
                @Override public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode code, String error) { audioError(error); }
                @Override public void onWebRtcAudioRecordError(String error) { audioError(error); }
            }).createAudioDeviceModule();
        try {
            factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm)
                .setVideoEncoderFactory(module.mVideoEncoderFactory).setVideoDecoderFactory(module.mVideoDecoderFactory)
                .createPeerConnectionFactory();
        } finally { adm.release(); }
        MediaConstraints constraints = new MediaConstraints();
        for (String key : new String[]{"googEchoCancellation", "googNoiseSuppression", "googNoiseSuppression2", "googAutoGainControl", "googAutoGainControl2", "googHighpassFilter"}) {
            constraints.mandatory.add(new MediaConstraints.KeyValuePair(key, "false"));
        }
        source = factory.createAudioSource(constraints);
        track = factory.createAudioTrack(session, source);
        final WritableMap[] result = new WritableMap[1];
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
    static void releaseAudio(String expectedSession, Runnable completed) {
        if (expectedSession != null && !expectedSession.equals(session)) { completed.run(); return; }
        releaseCallbacks.add(completed);
        releaseRequested = true;
        finishRelease();
    }
    private static void finishRelease() {
        // RN's close() only closes signaling. Its JS closed event later calls
        // peerConnectionDispose(). Wait for that native dispose before freeing
        // the factory's worker threads/ADM, even if the bridge is delayed.
        if (!releaseRequested || !screenPeers.isEmpty()) return;
        if (track != null) { track.dispose(); track = null; }
        if (source != null) { source.dispose(); source = null; }
        if (factory != null) { factory.dispose(); factory = null; }
        playbackRecords.clear();
        session = null;
        reactContext = null;
        releaseRequested = false;
        List<Runnable> callbacks = new ArrayList<>(releaseCallbacks);
        releaseCallbacks.clear();
        for (Runnable callback : callbacks) callback.run();
    }
}
