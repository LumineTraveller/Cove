import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  MobileRemoteControl,
  type MobileRemoteState,
} from './mobileRemoteControl';
import type {
  RemoteControlInput,
  RemoteMouseButton,
  RemotePoint,
} from './remoteInput';

export function useMobileRemoteControl({
  socket,
  roomId,
  targetSocketId,
  allowed = true,
}: {
  socket: Socket | null;
  roomId: string;
  targetSocketId: string | null;
  allowed?: boolean;
}) {
  const controller = useRef<MobileRemoteControl | null>(null);
  const inputEnabled = useRef(true);
  const target = useRef({ targetSocketId, allowed });
  target.current = { targetSocketId, allowed };
  const [state, setState] = useState<MobileRemoteState>({
    session: null,
    pending: null,
    error: null,
  });
  useEffect(() => {
    setState({ session: null, pending: null, error: null });
    if (!socket) return;
    const next = new MobileRemoteControl({ socket, roomId, onState: setState });
    next.setTarget(target.current.targetSocketId, target.current.allowed);
    next.setInputEnabled(inputEnabled.current);
    controller.current = next;
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [socket, roomId]);
  useEffect(() => {
    controller.current?.setTarget(targetSocketId, allowed);
  }, [targetSocketId, allowed]);
  const setInputEnabled = useCallback((enabled: boolean) => {
    inputEnabled.current = enabled;
    controller.current?.setInputEnabled(enabled);
  }, []);
  const request = useCallback(
    (targetId?: string) => controller.current?.request(targetId) ?? false,
    [],
  );
  const cancel = useCallback(() => controller.current?.cancel(), []);
  const stop = useCallback(() => controller.current?.stop(), []);
  const send = useCallback(
    (input: RemoteControlInput) => controller.current?.send(input) ?? false,
    [],
  );
  const pointer = useCallback(
    (point: RemotePoint) => controller.current?.pointer(point) ?? false,
    [],
  );
  const button = useCallback(
    (name: RemoteMouseButton, down: boolean, point: RemotePoint) =>
      controller.current?.button(name, down, point) ?? false,
    [],
  );
  const click = useCallback(
    (point: RemotePoint, name?: RemoteMouseButton) =>
      controller.current?.click(point, name) ?? false,
    [],
  );
  const wheel = useCallback(
    (point: RemotePoint, deltaX: number, deltaY: number) =>
      controller.current?.wheel(point, deltaX, deltaY) ?? false,
    [],
  );
  const key = useCallback(
    (code: string, down: boolean) =>
      controller.current?.key(code, down) ?? false,
    [],
  );
  const shortcut = useCallback(
    (codes: readonly string[]) => controller.current?.shortcut(codes) ?? false,
    [],
  );
  const typeText = useCallback(
    (text: string) =>
      controller.current?.typeText(text) ?? Promise.resolve(false),
    [],
  );
  return {
    ...state,
    setInputEnabled,
    typeText,
    request,
    cancel,
    stop,
    send,
    pointer,
    button,
    click,
    wheel,
    key,
    shortcut,
  };
}
