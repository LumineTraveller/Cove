import { DisconnectGrace as SharedDisconnectGrace } from '@cove/client-core';
export const DISCONNECT_GRACE_MS = 5_000;
export class DisconnectGrace extends SharedDisconnectGrace {
  constructor() {
    super(DISCONNECT_GRACE_MS);
  }
}
