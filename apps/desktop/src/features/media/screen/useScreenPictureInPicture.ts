import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createScreenPictureInPicture, type ScreenPictureInPictureState } from './screenPictureInPicture';

export function useScreenPictureInPicture(host: RefObject<HTMLElement>, source: MediaStream | null) {
  const controller = useRef<ReturnType<typeof createScreenPictureInPicture> | null>(null);
  const [state, setState] = useState<ScreenPictureInPictureState>({
    supported: false, active: false, pending: false, error: null,
  });
  useEffect(() => {
    const owner = createScreenPictureInPicture({
      document,
      getVideo: () => host.current?.querySelector('video') ?? null,
      onState: setState,
      onReturn: () => { void window.coveWindow?.focus().catch(() => {}); },
    });
    controller.current = owner;
    return () => { owner.dispose(); if (controller.current === owner) controller.current = null; };
  }, [host]);
  useEffect(() => { controller.current?.setSource(source); }, [source, host]);
  const open = useCallback(() => controller.current?.open() ?? Promise.resolve(), []);
  const close = useCallback(() => controller.current?.close() ?? Promise.resolve(), []);
  return { ...state, open, close };
}
