import { useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';

import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
import {
  Transport,
  Producer,
  waitForMediaTrackWarmup,
  produceWithSsrcRetry,
} from '../desktopMediaSupport';

export interface useScreenAudioDependencies {
  readonly mediaGeneration: import('react').MutableRefObject<number>;
  readonly screenAudioProducer: import('react').MutableRefObject<Producer | null>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly screenAudioUnsubscribe: import('react').MutableRefObject<(() => void) | null>;
  readonly screenAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly screenShareVolumeRef: import('react').MutableRefObject<number>;
  readonly sendTransport: import('react').MutableRefObject<Transport | null>;
  readonly forceMutedRef: import('react').MutableRefObject<boolean>;
  readonly screenDemandActiveRef: import('react').MutableRefObject<boolean>;
}

export function useScreenAudio(deps: useScreenAudioDependencies) {
  const audioGeneration = useRef(0);
  const pendingStart = useRef<{ isCurrent: () => boolean; promise: Promise<void> } | null>(null);
  const closeScreenAudio = useCallback(() => {
    audioGeneration.current += 1;
    pendingStart.current = null;
    const producer = deps.screenAudioProducer.current;
    if (producer) {
      deps.socket.emit('ms:close-producer', { producerId: producer.id });
      producer.close();
      deps.screenAudioProducer.current = null;
    }
    deps.screenAudioUnsubscribe.current?.();
    deps.screenAudioUnsubscribe.current = null;
    deps.screenAudioPipeline.current?.close();
    deps.screenAudioPipeline.current = null;
    void window.coveScreenAudio?.stop();
  }, [deps.socket]);

  const startScreenAudio = useCallback(async (publicationCurrent: () => boolean = () => true) => {
    if (pendingStart.current?.isCurrent()) return pendingStart.current.promise;
    if (pendingStart.current) closeScreenAudio();
    if (deps.screenAudioProducer.current && !deps.screenAudioProducer.current.closed) return;
    const bridge = window.coveScreenAudio;
    if (!bridge) throw new Error('无法启动排除 Cove 音频的系统捕获。');
    const transport = deps.sendTransport.current;
    if (!transport) throw new Error('屏幕音频会话已结束');
    const operation = ++audioGeneration.current;
    const generation = deps.mediaGeneration.current;
    const socketId = deps.socket.id;
    const isCurrent = () => operation === audioGeneration.current && publicationCurrent() &&
      generation === deps.mediaGeneration.current && transport === deps.sendTransport.current && socketId === deps.socket.id;
    const ensureCurrent = () => { if (!isCurrent()) throw new Error('屏幕音频操作已取消'); };
    const run = async () => {
      let pipeline: ApplicationAudioPipeline | null = null;
      let unsubscribe: (() => void) | null = null;
      let producer: Producer | null = null;
      try {
        // Keep the captured pipeline in a stable closure. The IPC listener must
        // continue forwarding every PCM chunk to the same MediaStream destination.
        const audioPipeline = new ApplicationAudioPipeline(deps.screenShareVolumeRef.current);
        pipeline = audioPipeline;
        // Own the pipeline before awaiting native setup, so teardown can release
        // it immediately even while the start acknowledgement is still pending.
        deps.screenAudioPipeline.current = audioPipeline;
        await audioPipeline.resume();
        ensureCurrent();
        audioPipeline.prime();
        const removeListener = bridge.onChunk((chunk) => { if (isCurrent()) audioPipeline.pushPcm(chunk); });
        let removed = false;
        unsubscribe = () => { if (!removed) { removed = true; removeListener(); } };
        deps.screenAudioUnsubscribe.current = unsubscribe;
        const capture = await bridge.start();
        ensureCurrent();
        if (!capture?.ok) throw new Error(capture?.error ?? '无法启动排除 Cove 自身声音的系统捕获。');

        const track = audioPipeline.track;
        await waitForMediaTrackWarmup(track);
        ensureCurrent();
        producer = await produceWithSsrcRetry(() => {
          ensureCurrent();
          return transport.produce({
            track,
            streamId: `screen-${deps.socket.id}`,
            codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
            appData: { type: 'screen-audio' },
            stopTracks: false,
            disableTrackOnPause: true,
            zeroRtpOnPause: true,
          });
        });
        ensureCurrent();
        deps.screenAudioProducer.current = producer;
        if (deps.forceMutedRef.current || !deps.screenDemandActiveRef.current) producer.pause();
      } catch (error) {
        if (deps.screenAudioProducer.current === producer) deps.screenAudioProducer.current = null;
        if (producer && !producer.closed) {
          if (deps.socket.id === socketId && deps.socket.connected !== false)
            deps.socket.emit('ms:close-producer', { producerId: producer.id });
          producer.close();
        }
        unsubscribe?.();
        pipeline?.close();
        if (deps.screenAudioUnsubscribe.current === unsubscribe) deps.screenAudioUnsubscribe.current = null;
        if (deps.screenAudioPipeline.current === pipeline) deps.screenAudioPipeline.current = null;
        // The native bridge is global: only its current owner may stop capture.
        if (operation === audioGeneration.current) await bridge.stop().catch(() => false);
        throw error;
      }
    };
    const promise = run().finally(() => {
      if (pendingStart.current?.promise === promise) pendingStart.current = null;
    });
    pendingStart.current = { isCurrent, promise };
    return promise;
  }, [closeScreenAudio, deps.mediaGeneration]);
  return { closeScreenAudio, startScreenAudio };
}
