/**
 * WebRTC `disconnected` is recoverable; it can transition back to `connected`
 * without rebuilding the voice session. Only `failed` is terminal enough to
 * start tearing the session down.
 */
export function shouldResetVoiceForTransportState(state: string): boolean {
  return state === "failed";
}

/**
 * Signalling may be down while media is still usable or recovering. Let the
 * media transports' own failure deadline decide when a voice reset is needed.
 */
export function hasRecoverableMediaTransport(
  ...states: Array<string | null>
): boolean {
  return states.some(
    (state) => state !== null && state !== "failed" && state !== "closed",
  );
}
