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

interface CoveWindowApi {
  minimize(): Promise<boolean>;
  toggleMaximize(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  close(): Promise<boolean>;
  onState(listener: (maximized: boolean) => void): () => void;
}

interface CoveClipboardApi {
  writeText(value: string): Promise<boolean>;
  writeImage(value: Uint8Array): Promise<boolean>;
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

interface CoveSystemAudioApi {
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
    coveWindow?: CoveWindowApi;
    coveClipboard?: CoveClipboardApi;
    coveSecurity?: CoveSecurityApi;
    coveApplicationAudio?: CoveApplicationAudioApi;
    coveScreenAudio?: CoveScreenAudioApi;
    coveSystemAudio?: CoveSystemAudioApi;
    coveRemoteControl?: CoveRemoteControlApi;
  }
}

export {};
