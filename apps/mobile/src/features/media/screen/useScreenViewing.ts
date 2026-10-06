import { useCallback, useRef } from 'react';

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
  return { stopWatchingScreen, watchScreen, captureWatchGuard };
}
