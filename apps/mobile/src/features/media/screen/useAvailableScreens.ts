import { useCallback } from 'react';

import { AvailableScreen } from '../mobileMediaSupport';

export interface UseAvailableScreensDependencies {
  readonly setAvailableScreens: import('react').Dispatch<
    import('react').SetStateAction<AvailableScreen[]>
  >;
  readonly availableScreensRef: import('react').RefObject<
    Map<string, AvailableScreen>
  >;
}

export function useAvailableScreens(deps: UseAvailableScreensDependencies) {
  const { setAvailableScreens, availableScreensRef } = deps;

  const publishAvailableScreens = useCallback(() => {
    setAvailableScreens([...availableScreensRef.current.values()]);
  }, [availableScreensRef, setAvailableScreens]);

  const storeAvailableScreen = useCallback(
    (screen: AvailableScreen) => {
      availableScreensRef.current.set(screen.socketId, screen);
      publishAvailableScreens();
    },
    [availableScreensRef, publishAvailableScreens],
  );

  const removeAvailableScreen = useCallback(
    (socketId: string, videoProducerId?: string) => {
      const current = availableScreensRef.current.get(socketId);
      if (
        !current ||
        (videoProducerId && current.videoProducerId !== videoProducerId)
      )
        return;
      availableScreensRef.current.delete(socketId);
      publishAvailableScreens();
    },
    [availableScreensRef, publishAvailableScreens],
  );

  const clearAvailableScreens = useCallback(() => {
    availableScreensRef.current.clear();
    publishAvailableScreens();
  }, [availableScreensRef, publishAvailableScreens]);
  return {
    publishAvailableScreens,
    storeAvailableScreen,
    removeAvailableScreen,
    clearAvailableScreens,
  };
}
