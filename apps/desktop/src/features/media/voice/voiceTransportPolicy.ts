/**
 * WebRTC `disconnected` is recoverable; it can transition back to `connected`
 * without rebuilding the voice session. Only `failed` is terminal enough to
 * start tearing the session down.
 */
export function shouldResetVoiceForTransportState(state: string): boolean {
  return state === 'failed';
}

export { hasRecoverableMediaTransport } from '@cove/client-core';
