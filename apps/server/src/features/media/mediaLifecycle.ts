import type { PeerInfo } from './ms';

// Peer identity survives voice leave/rejoin and short signaling recovery. Pending
// SFU operations must therefore track a session generation as well as identity.
const generations = new WeakMap<PeerInfo, number>();
export function mediaGeneration(peer: PeerInfo): number {
  return generations.get(peer) ?? 0;
}
export function invalidateMediaSession(peer: PeerInfo): void {
  generations.set(peer, mediaGeneration(peer) + 1);
}

// Shared across recovered Socket instances: an older transport allocation must
// never replace a newer request that has already completed.
const transportRequests = new WeakMap<PeerInfo, Map<string, number>>();
export function beginTransportRequest(peer: PeerInfo, role: string): () => boolean {
  let requests = transportRequests.get(peer);
  if (!requests) transportRequests.set(peer, requests = new Map());
  const request = (requests.get(role) ?? 0) + 1;
  requests.set(role, request);
  return () => requests!.get(role) === request;
}
