export interface ProcessedMicrophone {
  stream: MediaStream;
  context: AudioContext | null;
  gain: GainNode | null;
}

// About 1.1 dB of room for the native compressor's transient overshoot at 200%.
export const MICROPHONE_HEADROOM = 0.88;
export const MICROPHONE_GAIN_RAMP_SECONDS = 0.02;

export function syncMicrophoneMute(
  producer: {
    pause(): void;
    resume(): void;
    track?: MediaStreamTrack | null;
  },
  selfMuted: boolean,
  forceMuted: boolean,
  volume: number,
): void {
  // Zero volume must remain silent even if AudioContext failed and the
  // producer is sending the raw capture track. Never override either mute.
  const muted = selfMuted || forceMuted || volume === 0;
  // mediasoup pause/resume controls RTP, while track.enabled controls the
  // source itself. Keep both in sync so a track installed while muted can be
  // enabled again when the user raises the microphone volume.
  if (producer.track) producer.track.enabled = !muted;
  if (muted) producer.pause();
  else producer.resume();
}

function microphoneGain(volume: number): number {
  return Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
}

export function setMicrophoneGain(gain: GainNode, volume: number): void {
  const now = gain.context.currentTime;
  const parameter = gain.gain;
  // Hold the instantaneous value when the slider moves again mid-ramp. A
  // direct .value assignment (or restarting from its old target) can click.
  // Older Chromium builds do not expose cancelAndHoldAtTime, so retain the
  // same continuous-ramp behavior with the broadly supported fallback.
  const cancelAndHoldAtTime = (
    parameter as AudioParam & {
      cancelAndHoldAtTime?: (time: number) => AudioParam;
    }
  ).cancelAndHoldAtTime;
  if (typeof cancelAndHoldAtTime === "function")
    cancelAndHoldAtTime.call(parameter, now);
  else parameter.cancelScheduledValues(now);
  // Also anchor the first ramp explicitly: with no earlier automation event,
  // linearRampToValueAtTime can otherwise interpolate from time zero.
  parameter.setValueAtTime(parameter.value, now);
  parameter.linearRampToValueAtTime(
    microphoneGain(volume),
    now + MICROPHONE_GAIN_RAMP_SECONDS,
  );
}

/**
 * Capture already runs Chromium's AEC, noise suppression and AGC (see
 * createMicrophoneConstraints). Do not stack spectral subtraction, gates or
 * fixed 50/100/150 Hz notches on top: they can remove speech harmonics and
 * introduce musical noise. This graph ONLY controls the user's send volume.
 * Keep it shared with the OfflineAudioContext regression tests.
 */
export function connectMicrophoneGain(
  context: BaseAudioContext,
  source: AudioNode,
  destination: AudioNode,
  volume: number,
): GainNode {
  const gain = context.createGain();
  gain.gain.value = microphoneGain(volume);

  const peakCompressor = context.createDynamicsCompressor();
  // No compression or automatic makeup at normal levels. Only peaks above
  // full scale after the optional 100–200% boost are compressed. Native
  // lookahead plus output headroom reduces overload; this is not a hard clamp.
  peakCompressor.threshold.value = 0;
  peakCompressor.knee.value = 0;
  peakCompressor.ratio.value = 20;
  peakCompressor.attack.value = 0;
  peakCompressor.release.value = 0.1;
  peakCompressor.channelCount = 1;
  peakCompressor.channelCountMode = "explicit";

  const headroom = context.createGain();
  headroom.gain.value = MICROPHONE_HEADROOM;
  source
    .connect(gain)
    .connect(peakCompressor)
    .connect(headroom)
    .connect(destination);
  return gain;
}

export async function createProcessedMicrophone(
  rawStream: MediaStream,
  volume: number,
  createContext: () => AudioContext,
): Promise<ProcessedMicrophone> {
  let context: AudioContext | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    context = createContext();
    const source = context.createMediaStreamSource(rawStream);
    destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    const gain = connectMicrophoneGain(context, source, destination, volume);
    // A suspended Electron context can leave resume() pending indefinitely.
    // Never let this prevent joining voice with the original capture track.
    await Promise.race([
      context.resume(),
      new Promise<never>((_, reject) => {
        resumeTimer = setTimeout(
          () => reject(new Error("Microphone AudioContext resume timed out")),
          2_000,
        );
      }),
    ]);
    const track = destination.stream.getAudioTracks()[0];
    if (context.state !== "running" || track?.readyState !== "live") {
      throw new Error("Microphone gain graph did not become usable");
    }
    track.contentHint = "speech";
    return { stream: destination.stream, context, gain };
  } catch (error) {
    // The raw stream still has native APM. Only dispose resources owned by
    // this graph; stopping rawStream here would also break the fallback.
    destination?.stream.getTracks().forEach((track) => track.stop());
    if (context) await context.close().catch(() => {});
    console.warn("[mic] 音量处理不可用，回退到系统降噪音轨", error);
    return { stream: rawStream, context: null, gain: null };
  } finally {
    if (resumeTimer !== undefined) clearTimeout(resumeTimer);
  }
}
