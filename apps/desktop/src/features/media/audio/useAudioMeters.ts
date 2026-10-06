import { useCallback } from 'react';

import { applyAudioContextOutput } from './audioDevices';

export interface useAudioMetersDependencies {
  readonly audioCtxRef: import('react').MutableRefObject<AudioContext | null>;
  readonly masterOutputGain: import('react').MutableRefObject<GainNode | null>;
  readonly masterOutputVolumeRef: import('react').MutableRefObject<number>;
  readonly selectedAudioOutputRef: import('react').MutableRefObject<string>;
  readonly analysers: import('react').MutableRefObject<
    Map<
      string,
      {
        source: MediaStreamAudioSourceNode;
        analyser: AnalyserNode;
        data: Uint8Array<ArrayBuffer>;
        socketId: string;
        stream: MediaStream;
        type: 'voice' | 'application';
        playbackGain: () => number;
      }
    >
  >;
  readonly volumeTimer: import('react').MutableRefObject<number | null>;
  readonly setSpeakingLevels: import('react').Dispatch<
    import('react').SetStateAction<Record<string, number>>
  >;
  readonly setSharedAudioLevels: import('react').Dispatch<
    import('react').SetStateAction<Record<string, number>>
  >;
}

export function useAudioMeters(deps: useAudioMetersDependencies) {
  // ── 音量分析工具 ──────────────────────────────────────────────────────────────
  const ensureAudioCtx = useCallback(() => {
    if (!deps.audioCtxRef.current) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      deps.audioCtxRef.current = new Ctx();
      deps.masterOutputGain.current = deps.audioCtxRef.current.createGain();
      deps.masterOutputGain.current.gain.value = deps.masterOutputVolumeRef.current;
      deps.masterOutputGain.current.connect(deps.audioCtxRef.current.destination);
      applyAudioContextOutput(deps.audioCtxRef.current, deps.selectedAudioOutputRef.current).catch(
        (error) => {
          console.warn('[audio] 提示音切换输出设备失败', error);
        },
      );
    }
    return deps.audioCtxRef.current;
  }, []);

  const playPresenceTone = useCallback(
    (action: 'join' | 'leave') => {
      try {
        const context = ensureAudioCtx();
        context.resume().catch(() => {});
        const frequencies = action === 'join' ? [523.25, 659.25] : [493.88, 392.0];
        const start = context.currentTime;
        frequencies.forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const noteStart = start + index * 0.11;
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, noteStart);
          gain.gain.exponentialRampToValueAtTime(0.13, noteStart + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.13);
          oscillator.connect(gain).connect(deps.masterOutputGain.current ?? context.destination);
          oscillator.start(noteStart);
          oscillator.stop(noteStart + 0.14);
        });
      } catch {
        /* 音效失败不影响语音 */
      }
    },
    [ensureAudioCtx],
  );

  const attachAnalyser = (
    key: string,
    stream: MediaStream,
    socketId: string,
    type: 'voice' | 'application' = 'voice',
    playbackGain: () => number = () => 1,
  ) => {
    detachAnalyser(key);
    try {
      const ctx = ensureAudioCtx();
      if (type === 'application' && ctx.state !== 'running') {
        void ctx.resume().catch(() => {});
      }
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser); // 不连到 destination，避免重复播放
      deps.analysers.current.set(key, {
        source: src,
        analyser,
        data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
        socketId,
        stream,
        type,
        playbackGain,
      });
    } catch {
      /* ignore */
    }
  };

  const detachAnalyser = (key: string) => {
    const entry = deps.analysers.current.get(key);
    entry?.source.disconnect();
    entry?.analyser.disconnect();
    deps.analysers.current.delete(key);
  };

  const clearAnalysers = () => {
    for (const key of deps.analysers.current.keys()) detachAnalyser(key);
  };

  // 音量计：每 100ms 计算每路音频的 RMS，聚合到 socketId → 0~1
  const startMeters = useCallback(() => {
    if (deps.volumeTimer.current) return;
    deps.volumeTimer.current = setInterval(() => {
      if (deps.analysers.current.size === 0) {
        deps.setSpeakingLevels({});
        deps.setSharedAudioLevels({});
        return;
      }
      const levels: Record<string, number> = {};
      const sharedLevels: Record<string, number> = {};
      deps.analysers.current.forEach(({ analyser, data, socketId, stream, type, playbackGain }) => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const active =
          type === 'voice' ||
          (deps.audioCtxRef.current?.state === 'running' &&
            stream
              .getAudioTracks()
              .some((track) => track.enabled && !track.muted && track.readyState === 'live'));
        const gain = active ? playbackGain() : 0;
        // 电平只表示输入信号强度：增益只作"是否在出声"的开关，不参与幅度。
        // 否则音量会在电平里乘一次、又在 UI 的封顶比值里乘一次，低音量时电表几乎不动。
        const level = gain > 0 ? Math.min(1, rms * 3) : 0; // 放大便于观察
        const target = type === 'application' ? sharedLevels : levels;
        target[socketId] = Math.max(target[socketId] ?? 0, level);
      });
      deps.setSpeakingLevels(levels);
      deps.setSharedAudioLevels(sharedLevels);
    }, 100);
  }, []);

  const stopMeters = useCallback(() => {
    if (deps.volumeTimer.current) {
      clearInterval(deps.volumeTimer.current);
      deps.volumeTimer.current = null;
    }
    deps.setSpeakingLevels({});
    deps.setSharedAudioLevels({});
  }, []);
  return {
    ensureAudioCtx,
    playPresenceTone,
    attachAnalyser,
    detachAnalyser,
    clearAnalysers,
    startMeters,
    stopMeters,
  };
}
