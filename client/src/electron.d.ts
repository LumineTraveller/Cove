import type { UpdateState } from './update';

interface CoveUpdaterApi {
  getState(): Promise<UpdateState>;
  checkNow(): Promise<UpdateState>;
  installNow(): Promise<boolean>;
  onState(listener: (state: UpdateState) => void): () => void;
}

interface CoveShellApi {
  openExternal(url: string): Promise<boolean>;
}

interface CoveDiagnosticsApi {
  append(entry: unknown): Promise<boolean>;
  openLog(): Promise<boolean>;
}

declare global {
  interface Window {
    coveUpdater?: CoveUpdaterApi;
    coveShell?: CoveShellApi;
    coveDiagnostics?: CoveDiagnosticsApi;
  }
}

export {};
