import { useCallback, useEffect, useRef } from 'react';
import { createScreenWatchRecovery, type ScreenPublication, type ScreenPublicationClosed } from '@cove/client-core';

import { MediaStream } from 'react-native-webrtc';

import { Consumer, RemoteScreen, AvailableScreen } from '../mobileMediaSupport';

export interface UseScreenViewingDependencies {
  readonly watchingScreenPeerRef: import('react').RefObject<string | null>;
  readonly consumers: import('react').RefObject<
    Map<
      string,
      {
        consumer: Consumer;
        producerId: string;
        socketId: string;
        kind: string;
        stream: MediaStream;
        sourceType?: string;
      }
    >
  >;
  readonly removeConsumer: (consumerId: string, notifyServer?: boolean) => void;
  readonly setIsWatchingScreen: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setRemoteScreen: import('react').Dispatch<
    import('react').SetStateAction<RemoteScreen | null>
  >;
  readonly availableScreensRef: import('react').RefObject<
    Map<string, AvailableScreen>
  >;
  readonly consumeProducer: (
    producerId: string,
    peerId: string,
    kind: string,
    appData?: Record<string, unknown>,
    isCurrent?: () => boolean,
  ) => Promise<boolean>;
}

export function useScreenViewing(deps: UseScreenViewingDependencies) {
  const watchEpoch = useRef(0);
  const recovery = useRef<ReturnType<typeof createScreenWatchRecovery> | null>(null);
  const recoveryActions = useRef<{
    replacing: (peerId: string) => void;
    resume: (source: ScreenPublication, current: () => boolean) => Promise<boolean>;
    stop: () => void;
  } | null>(null);
  const {
    watchingScreenPeerRef,
    consumers,
    removeConsumer,
    setIsWatchingScreen,
    setRemoteScreen,
    availableScreensRef,
    consumeProducer,
  } = deps;

  // Also used for screen audio announced after viewing has already started.
  const captureWatchGuard = useCallback((peerId: string) => {
    const epoch = watchEpoch.current;
    return () => watchEpoch.current === epoch && watchingScreenPeerRef.current === peerId;
  }, [watchingScreenPeerRef]);

  const stopWatchingScreen = useCallback(() => {
    recovery.current?.cancel();
    watchEpoch.current += 1;
    const peerId = watchingScreenPeerRef.current;
    if (!peerId) return;
    for (const [consumerId, entry] of [...consumers.current]) {
      if (
        entry.socketId === peerId &&
        (entry.sourceType === 'screen' || entry.sourceType === 'screen-audio')
      ) {
        removeConsumer(consumerId, true);
      }
    }
    watchingScreenPeerRef.current = null;
    setIsWatchingScreen(false);
    setRemoteScreen(null);
  }, [
    consumers,
    removeConsumer,
    setIsWatchingScreen,
    setRemoteScreen,
    watchingScreenPeerRef,
  ]);

  recoveryActions.current = {
    replacing: peerId => {
      watchEpoch.current++;
      for (const [consumerId, entry] of [...consumers.current]) {
        if (entry.socketId === peerId && ['screen', 'screen-audio'].includes(entry.sourceType ?? ''))
          removeConsumer(consumerId, true);
      }
    },
    resume: async (source, current) => {
      const guard = captureWatchGuard(source.socketId);
      const isCurrent = () => current() && guard();
      const ok = await consumeProducer(source.videoProducerId, source.socketId, 'video', { type: 'screen' }, isCurrent);
      if (!ok || !isCurrent()) return false;
      const latest = availableScreensRef.current.get(source.socketId);
      if (latest?.audioProducerId)
        await consumeProducer(latest.audioProducerId, source.socketId, 'audio', { type: 'screen-audio' }, isCurrent);
      return isCurrent();
    },
    stop: stopWatchingScreen,
  };
  if (!recovery.current) recovery.current = createScreenWatchRecovery({
    isWatching: peerId => watchingScreenPeerRef.current === peerId,
    onReplacing: peerId => recoveryActions.current!.replacing(peerId),
    resume: (source, current) => recoveryActions.current!.resume(source, current),
    stop: () => recoveryActions.current!.stop(),
  });
  useEffect(() => () => recovery.current?.cancel(), []);
  const screenPublicationAvailable = useCallback((source: AvailableScreen) => recovery.current?.sourceAvailable(source), []);
  const screenPublicationClosed = useCallback((closed: ScreenPublicationClosed) => recovery.current?.sourceClosed(closed), []);

  const watchScreen = useCallback(
    async (socketId?: string) => {
      const source = socketId
        ? availableScreensRef.current.get(socketId)
        : (availableScreensRef.current.values().next().value as
            | AvailableScreen
            | undefined);
      if (!source || watchingScreenPeerRef.current === source.socketId) return;
      if (watchingScreenPeerRef.current) stopWatchingScreen();
      const epoch = ++watchEpoch.current;
      const isCurrent = () => watchEpoch.current === epoch &&
        watchingScreenPeerRef.current === source.socketId;
      watchingScreenPeerRef.current = source.socketId;
      recovery.current!.begin(source);
      setIsWatchingScreen(true);
      const videoOk = await consumeProducer(
        source.videoProducerId,
        source.socketId,
        'video',
        { type: 'screen' },
        isCurrent,
      );
      if (!isCurrent()) return;
      if (!videoOk) {
        recovery.current?.cancel();
        watchingScreenPeerRef.current = null;
        setIsWatchingScreen(false);
        return;
      }
      const current = availableScreensRef.current.get(source.socketId);
      if (current?.audioProducerId) {
        await consumeProducer(
          current.audioProducerId,
          source.socketId,
          'audio',
          { type: 'screen-audio' },
          isCurrent,
        );
      }
    },
    [
      availableScreensRef,
      consumeProducer,
      setIsWatchingScreen,
      stopWatchingScreen,
      watchingScreenPeerRef,
    ],
  );
  return { stopWatchingScreen, watchScreen, captureWatchGuard, screenPublicationAvailable, screenPublicationClosed };
}
