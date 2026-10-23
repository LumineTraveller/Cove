import { REMOTE_CONTROL_REQUEST_TTL_MS, type RemoteControlRegistry, type RemoteControlRequest } from './remoteControl';

// One registry belongs to one server runtime. A settled request owns no timer.
const timers = new WeakMap<RemoteControlRegistry, Map<string, ReturnType<typeof setTimeout>>>();
export function cancelRemoteRequestExpiration(registry: RemoteControlRegistry, requestId: string): void {
  const owned = timers.get(registry);
  const timer = owned?.get(requestId);
  if (timer) clearTimeout(timer);
  owned?.delete(requestId);
  if (!owned?.size) timers.delete(registry);
}
export function scheduleRemoteRequestExpiration(registry: RemoteControlRegistry, request: RemoteControlRequest,
  onExpired: (request: RemoteControlRequest) => void): void {
  cancelRemoteRequestExpiration(registry, request.requestId);
  let owned = timers.get(registry);
  if (!owned) { owned = new Map(); timers.set(registry, owned); }
  owned.set(request.requestId, setTimeout(() => {
    cancelRemoteRequestExpiration(registry, request.requestId);
    const expired = registry.expireRequest(request.requestId);
    if (expired) onExpired(expired);
  }, REMOTE_CONTROL_REQUEST_TTL_MS + 50));
}
export function clearRemoteRequestExpirations(registry: RemoteControlRegistry): void {
  for (const timer of timers.get(registry)?.values() ?? []) clearTimeout(timer);
  timers.delete(registry);
}
