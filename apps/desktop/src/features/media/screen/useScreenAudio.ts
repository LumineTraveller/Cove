import { useCallback } from 'react';
import { Socket } from 'socket.io-client';

import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
import {
  Transport,
  Producer,
  waitForMediaTrackWarmup,
  produceWithSsrcRetry,
} from '../desktopMediaSupport';

export interface useScreenAudioDependencies {
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
  const closeScreenAudio = useCallback(() => {
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

  const startScreenAudio = useCallback(async () => {
    const bridge = window.coveScreenAudio;
    if (!bridge) throw new Error('无法启动排除 Cove 音频的系统捕获。');
    let pipeline: ApplicationAudioPipeline | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      // Keep the captured pipeline in a stable closure. The IPC listener must
      // continue forwarding every PCM chunk to the same MediaStream destination.
      const audioPipeline = new ApplicationAudioPipeline(deps.screenShareVolumeRef.current);
      pipeline = audioPipeline;
      await audioPipeline.resume();
      audioPipeline.prime();
      unsubscribe = bridge.onChunk((chunk) => audioPipeline.pushPcm(chunk));
      const capture = await bridge.start();
      if (!capture?.ok) throw new Error(capture?.error ?? '无法启动排除 Cove 自身声音的系统捕获。');

      const track = audioPipeline.track;
      await waitForMediaTrackWarmup(track);
      const producer = await produceWithSsrcRetry(() =>
        deps.sendTransport.current!.produce({
          track,
          streamId: `screen-${deps.socket.id}`,
          codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
          appData: { type: 'screen-audio' },
          stopTracks: false,
          disableTrackOnPause: true,
          zeroRtpOnPause: true,
        }),
      );
      deps.screenAudioPipeline.current = audioPipeline;
      deps.screenAudioUnsubscribe.current = unsubscribe;
      unsubscribe = null;
      deps.screenAudioProducer.current = producer;
      if (deps.forceMutedRef.current || !deps.screenDemandActiveRef.current) producer.pause();
    } catch (error) {
      unsubscribe?.();
      pipeline?.close();
      await bridge.stop().catch(() => false);
      throw error;
    }
  }, []);
  return { closeScreenAudio, startScreenAudio };
}
