import { io } from 'socket.io-client';
import { MOBILE_RELEASE_VERSION } from './clientVersion';
import {
  CLIENT_PROTOCOL_VERSION,
  getServerAccessToken,
  retainServerAccessForConnection,
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
  const socket = io(serverURL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4_000,
    timeout: 10_000,
    auth: serverSocketAuth(serverURL),
  });
  let releaseServerAccess = () => {};
  socket.on('connect', () => {
    releaseServerAccess();
    const auth = socket.auth;
    releaseServerAccess = retainServerAccessForConnection(
      serverURL, typeof auth === 'object' ? auth.serverAccessToken : null,
    );
  });
  socket.on('disconnect', () => releaseServerAccess());
  return socket;
}
