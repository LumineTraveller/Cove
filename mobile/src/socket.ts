import { io } from 'socket.io-client';
import { CLIENT_PROTOCOL_VERSION, getServerAccessToken } from './serverSecurity';

export function createCoveSocket(serverURL: string) {
  return io(serverURL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4_000,
    timeout: 10_000,
    auth: { serverAccessToken: getServerAccessToken(serverURL), clientProtocol: CLIENT_PROTOCOL_VERSION },
  });
}
