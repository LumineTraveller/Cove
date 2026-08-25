import type { UpdateState } from './update';

interface CoveUpdaterApi {
  getState(): Promise<UpdateState>;
  checkNow(): Promise<UpdateState>;
  installNow(): Promise<boolean>;
  onState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    coveUpdater?: CoveUpdaterApi;
  }
}

export {};
