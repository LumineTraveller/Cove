import type { UpdateState } from './update';
import type { ApplicationAudioSource } from './applicationAudio';

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

interface CoveSecurityApi {
  setServerCertificateException(serverUrl: string, enabled: boolean): Promise<string | null>;
}

interface CoveApplicationAudioApi {
  listSources(): Promise<ApplicationAudioSource[]>;
  start(sourceId: string): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<boolean>;
  onChunk(listener: (chunk: Uint8Array) => void): () => void;
}

declare global {
  interface Window {
    coveUpdater?: CoveUpdaterApi;
    coveShell?: CoveShellApi;
    coveDiagnostics?: CoveDiagnosticsApi;
    coveSecurity?: CoveSecurityApi;
    coveApplicationAudio?: CoveApplicationAudioApi;
  }
}

export {};
