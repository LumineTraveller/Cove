import { useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';

import { type RtcVideoCounterSample } from '../diagnostics/mediaDiagnostics';

import {
  Producer,
  Consumer,
  MediaStats,
  EMPTY_STATS,
  RemoteScreen,
  AvailableScreen,
} from '../desktopMediaSupport';

export interface useScreenViewingDependencies {
  readonly setAvailableScreens: import('react').Dispatch<
    import('react').SetStateAction<AvailableScreen[]>
  >;
  readonly availableScreensRef: import('react').MutableRefObject<Map<string, AvailableScreen>>;
  readonly consumers: import('react').MutableRefObject<
    Map<
      string,
      {
        consumer: Consumer;
        socketId: string;
        kind: string;
        producerId: string;
        sourceType?: string;
      }
    >
  >;
  readonly consumerByProducer: import('react').MutableRefObject<Map<string, string>>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly audioEls: import('react').MutableRefObject<Map<string, HTMLAudioElement>>;
  readonly remoteAudioOutputs: import('react').MutableRefObject<
    Map<
      string,
      {
        source: MediaStreamAudioSourceNode;
        gain: GainNode;
        setVolume(value: number): void;
        resume(): Promise<void>;
        close(): void;
      }
    >
  >;
  readonly detachAnalyser: (key: string) => void;
  readonly setScreenReceiveHasAudio: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly screenStreams: import('react').MutableRefObject<Map<string, MediaStream>>;
  readonly setRemoteScreen: import('react').Dispatch<
    import('react').SetStateAction<RemoteScreen | null>
  >;
  readonly watchingScreenPeerRef: import('react').MutableRefObject<string | null>;
  readonly setWatchingScreenPeer: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly videoCounterPrev: import('react').MutableRefObject<RtcVideoCounterSample | null>;
  readonly receiveLossPrev: import('react').MutableRefObject<{
    lost: number;
    packets: number;
  } | null>;
  readonly screenProducer: import('react').MutableRefObject<Producer | null>;
  readonly setStats: import('react').Dispatch<import('react').SetStateAction<MediaStats>>;
  readonly consumeProducer: (
    producerId: string,
    peerId: string,
    kind: string,
    appData: Record<string, unknown>,
    isCurrent?: () => boolean,
  ) => Promise<boolean>;
}

export function useScreenViewing(deps: useScreenViewingDependencies) {
  const watchEpoch = useRef(0);
  const publishAvailableScreens = useCallback(() => {
    deps.setAvailableScreens([...deps.availableScreensRef.current.values()]);
  }, []);

  const storeAvailableScreen = useCallback(
    (value: AvailableScreen) => {
      deps.availableScreensRef.current.set(value.socketId, value);
      publishAvailableScreens();
    },
    [publishAvailableScreens],
  );

  const removeAvailableScreen = useCallback(
    (socketId: string, videoProducerId?: string) => {
      const current = deps.availableScreensRef.current.get(socketId);
      if (!current || (videoProducerId && current.videoProducerId !== videoProducerId)) return;
      deps.availableScreensRef.current.delete(socketId);
      publishAvailableScreens();
    },
    [publishAvailableScreens],
  );

  const clearAvailableScreens = useCallback(() => {
    deps.availableScreensRef.current.clear();
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const closeLocalConsumer = useCallback(
    (consumerId: string, notifyServer: boolean) => {
      const entry = deps.consumers.current.get(consumerId);
      if (!entry) return;
      deps.consumers.current.delete(consumerId);
      deps.consumerByProducer.current.delete(entry.producerId);
      if (notifyServer) deps.socket.emit('ms:close-consumer', { consumerId });
      entry.consumer.close();
      const el = deps.audioEls.current.get(consumerId);
      if (el) {
        el.pause();
        el.srcObject = null;
        deps.audioEls.current.delete(consumerId);
      }
      const output = deps.remoteAudioOutputs.current.get(consumerId);
      if (output) {
        output.close();
        deps.remoteAudioOutputs.current.delete(consumerId);
      }
      deps.detachAnalyser(consumerId);
      if (entry.sourceType === 'screen-audio') deps.setScreenReceiveHasAudio(false);
      if (entry.kind === 'video') {
        deps.screenStreams.current.delete(entry.socketId);
        deps.setScreenReceiveHasAudio(false);
        deps.setRemoteScreen((current) => (current?.socketId === entry.socketId ? null : current));
      }
    },
    [deps.socket],
  );

  // Also used for screen audio announced after viewing has already started.
  const captureWatchGuard = useCallback((peerId: string) => {
    const epoch = watchEpoch.current;
    return () => watchEpoch.current === epoch && deps.watchingScreenPeerRef.current === peerId;
  }, [deps.watchingScreenPeerRef]);

  const stopWatchingScreen = useCallback(() => {
    watchEpoch.current += 1;
    const peerId = deps.watchingScreenPeerRef.current;
    if (!peerId) return;
    for (const [consumerId, entry] of [...deps.consumers.current]) {
      if (
        entry.socketId !== peerId ||
        (entry.sourceType !== 'screen' && entry.sourceType !== 'screen-audio')
      )
        continue;
      closeLocalConsumer(consumerId, true);
    }
    deps.watchingScreenPeerRef.current = null;
    deps.setWatchingScreenPeer(null);
    deps.setRemoteScreen((current) => (current?.socketId === peerId ? null : current));
    deps.videoCounterPrev.current = null;
    deps.receiveLossPrev.current = null;
    if (!deps.screenProducer.current) deps.setStats(EMPTY_STATS);
  }, [closeLocalConsumer]);

  const watchScreen = useCallback(
    async (socketId?: string) => {
      const source = socketId
        ? deps.availableScreensRef.current.get(socketId)
        : (deps.availableScreensRef.current.values().next().value as AvailableScreen | undefined);
      if (!source || deps.watchingScreenPeerRef.current === source.socketId) return;
      if (deps.watchingScreenPeerRef.current) stopWatchingScreen();

      const epoch = ++watchEpoch.current;
      const isCurrent = () => watchEpoch.current === epoch &&
        deps.watchingScreenPeerRef.current === source.socketId;
      deps.watchingScreenPeerRef.current = source.socketId;
      deps.setWatchingScreenPeer(source.socketId);
      deps.videoCounterPrev.current = null;
      deps.receiveLossPrev.current = null;
      const videoOk = await deps.consumeProducer(source.videoProducerId, source.socketId, 'video', {
        type: 'screen',
      }, isCurrent);
      if (!isCurrent()) return;
      if (!videoOk) {
        deps.watchingScreenPeerRef.current = null;
        deps.setWatchingScreenPeer(null);
        return;
      }
      const latest = deps.availableScreensRef.current.get(source.socketId);
      if (latest?.audioProducerId)
        await deps.consumeProducer(latest.audioProducerId, source.socketId, 'audio', {
          type: 'screen-audio',
        }, isCurrent);
    },
    [deps.consumeProducer, stopWatchingScreen],
  );
  return {
    publishAvailableScreens,
    storeAvailableScreen,
    removeAvailableScreen,
    clearAvailableScreens,
    closeLocalConsumer,
    stopWatchingScreen,
    watchScreen,
    captureWatchGuard,
  };
}
