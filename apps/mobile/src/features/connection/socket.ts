import { io } from 'socket.io-client';
import { MOBILE_RELEASE_VERSION } from './clientVersion';
import {
  CLIENT_PROTOCOL_VERSION,
  getServerAccessToken,
} from './serverSecurity';

export function serverSocketAuth(serverURL: string) {
  return {
    serverAccessToken: getServerAccessToken(serverURL),
    clientProtocol: CLIENT_PROTOCOL_VERSION,
    clientVersion: MOBILE_RELEASE_VERSION,
    clientPlatform: 'mobile' as const,
  };
}

export function createCoveSocket(serverURL: string) {
  return io(serverURL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4_000,
    timeout: 10_000,
    auth: serverSocketAuth(serverURL),
  });
}
