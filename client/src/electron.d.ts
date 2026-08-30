import type { UpdateState } from './update';
import type { ApplicationAudioSource } from './applicationAudio';
import type { RemoteControlInput } from './remoteControl';

interface CoveUpdaterApi {
  getState(): Promise<UpdateState>;
  checkNow(): Promise<UpdateState>;
  installNow(): Promise<boolean>;
  openLog(): Promise<boolean>;
  onState(listener: (state: UpdateState) => void): () => void;
}

interface CoveShellApi {
  openExternal(url: string): Promise<boolean>;
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

interface CoveScreenAudioApi {
  start(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<boolean>;
  onChunk(listener: (chunk: Uint8Array) => void): () => void;
}

interface CoveRemoteControlApi {
  supported: boolean;
  setActive(sessionId: string | null): Promise<boolean>;
  sendInput(sessionId: string, input: RemoteControlInput): Promise<boolean>;
  onEmergencyStop(listener: () => void): () => void;
}

declare global {
  interface Window {
    coveUpdater?: CoveUpdaterApi;
    coveShell?: CoveShellApi;
    coveSecurity?: CoveSecurityApi;
    coveApplicationAudio?: CoveApplicationAudioApi;
    coveScreenAudio?: CoveScreenAudioApi;
    coveRemoteControl?: CoveRemoteControlApi;
  }
}

export {};
