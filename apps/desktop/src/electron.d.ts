import type { RemoteControlActivation } from '../electron/remote-control-activation';
import type { ApplicationAudioSource } from './features/media/application-audio/applicationAudio';
import type { RemoteControlInput } from './features/remote-control/remoteControl';
import type { UpdateState } from './features/updates/update';
import type { AnnotationOverlayFrame } from '../electron/annotation-overlay-state';
import type { AnnotationOverlayInput } from '../electron/annotation-overlay-input';

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
  focus(): Promise<boolean>;
  onState(listener: (maximized: boolean) => void): () => void;
  onResize?(listener: (active: boolean) => void): () => void;
}

interface CoveClipboardApi {
  writeText(value: string): Promise<boolean>;
  writeImage(
    value: Uint8Array,
    mimeType: 'image/png' | 'image/gif',
    pngFallback?: Uint8Array,
  ): Promise<boolean>;
  readGif(): Promise<Uint8Array | null>;
}

interface CoveSecurityApi {
  setServerCertificateException(serverUrl: string, enabled: boolean): Promise<string | null>;
  resolveServerAddresses(hostname: string): Promise<string[]>;
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
  setActive(sessionId: string | null): Promise<RemoteControlActivation>;
  sendInput(sessionId: string, input: RemoteControlInput): Promise<boolean>;
  onEmergencyStop(listener: (reason?: string) => void): () => void;
}

declare global {
  interface Window {
    coveAnnotationOverlay?: {
      bind(sessionId: string): Promise<{ token?: string; error?: string }>;
      update(token: string, frame: AnnotationOverlayFrame): Promise<boolean>;
      setInputActive(token: string, active: boolean): Promise<boolean>;
      onInput(listener: (event: { token: string; input: AnnotationOverlayInput }) => void): () => void;
      close(token: string): Promise<boolean>;
      onFailure(listener: (event: { token: string; reason: string }) => void): () => void;
    };
    coveAudioLatencyProfile?: 'adaptive' | 'legacy';
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
