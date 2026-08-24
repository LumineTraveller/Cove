import { io } from 'socket.io-client';

export function createCoveSocket(serverURL: string) {
  return io(serverURL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4_000,
    timeout: 10_000,
  });
}
