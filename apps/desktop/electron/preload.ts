import { contextBridge, ipcRenderer, sharedTexture } from "electron";
import type { NativeScreenFrame, NativeScreenOptions, NativeScreenStartResult } from './native-screen-capture-protocol';
import type { UpdateState } from "./updater-core";
import type { RemoteControlActivation } from "./remote-control-activation";
import type { RemoteControlInput } from "./remote-control";
import type { InstallationIntegrityState } from './integrity-state';

// Keep this bridge in the sandboxed preload: it may require Electron builtins,
// but cannot require an unbundled local runtime module. Handles never cross the
// context bridge. Each imported texture has its own transfer/release barrier.
const nativeFrameListeners = new Map<string, (frame: unknown, metadata: NativeScreenFrame) => Promise<void>>();
const nativeEndListeners = new Map<string, (reason: string) => void>();
const nativeReleasePermits = new Map<string, () => void>();
const nativeEarlyPermits = new Set<string>();
const nativeRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const nativeEnabled = process.platform === 'win32' && process.argv.includes('--cove-native-gpu-capture=1') &&
  typeof sharedTexture?.setSharedTextureReceiver === 'function';
const nativePermitKey = (metadata: NativeScreenFrame) => `${metadata.sessionId}:${metadata.serial}`;
// The intrinsic getter checks the ArrayBuffer internal slot across realms. A
// byteLength property or Symbol.toStringTag on an arbitrary object is not enough.
const nativeArrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
type NativeCpuVideoFrame = { close(): void };
type NativeCpuVideoFrameConstructor = new (data: ArrayBuffer, init: {
  format: 'NV12'; codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number; timestamp: number;
  layout: { offset: number; stride: number }[];
  colorSpace: { primaries: 'bt709'; transfer: 'bt709'; matrix: 'bt709'; fullRange: false };
  transfer: ArrayBuffer[];
}) => NativeCpuVideoFrame;
const nativeFrameValid = (value: NativeScreenFrame): boolean => Boolean(value && nativeRequestId(value.requestId) &&
  typeof value.sessionId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(value.sessionId) &&
  Number.isSafeInteger(value.serial) && value.serial > 0 && Number.isInteger(value.slot) && value.slot >= 0 && value.slot < 3 &&
  Number.isInteger(value.width) && value.width >= 2 && value.width <= 4096 &&
  Number.isInteger(value.height) && value.height >= 2 && value.height <= 2560 &&
  Number.isSafeInteger(value.timestamp) && value.timestamp >= 0 && typeof value.refresh === 'boolean' &&
  (value.pixelFormat === undefined || value.pixelFormat === 'bgra' || value.pixelFormat === 'nv12') &&
  (value.storage === undefined || value.storage === 'cpu'));

if (nativeEnabled) {
  ipcRenderer.on('cove:native-screen:release-permit', (_event, metadata: NativeScreenFrame) => {
    if (!nativeFrameValid(metadata) || metadata.storage !== undefined) return;
    const key = nativePermitKey(metadata);
    const release = nativeReleasePermits.get(key);
    if (release) { nativeReleasePermits.delete(key); release(); }
    else if (nativeEarlyPermits.size < 6) nativeEarlyPermits.add(key);
  });
  ipcRenderer.on('cove:native-screen:ended', (_event, event: { requestId: string; reason: string }) => {
    if (!event || !nativeRequestId(event.requestId) || typeof event.reason !== 'string') return;
    nativeEndListeners.get(event.requestId)?.(event.reason);
  });
  ipcRenderer.on('cove:native-screen:cpu-frame', async (_event, metadata: NativeScreenFrame, data: ArrayBuffer) => {
    if (!nativeFrameValid(metadata) || metadata.storage !== 'cpu' || metadata.pixelFormat !== 'nv12' ||
        metadata.width % 2 !== 0 || metadata.height % 2 !== 0) {
      if (nativeRequestId(metadata?.requestId)) {
        void ipcRenderer.invoke('cove:native-screen:stop', metadata.requestId, 'receiver_failed').catch(() => {});
      }
      return;
    }
    let frame: NativeCpuVideoFrame | undefined;
    let failed = false;
    const stopReceiver = () => {
      if (failed) return;
      failed = true;
      void ipcRenderer.invoke('cove:native-screen:stop', metadata.requestId, 'receiver_failed').catch(() => {});
    };
    try {
      const expectedBytes = metadata.width * metadata.height * 3 / 2;
      if (expectedBytes > 16 * 1024 * 1024 || nativeArrayBufferByteLength.call(data) !== expectedBytes) {
        throw new TypeError('invalid_native_cpu_frame_bytes');
      }
      const listener = nativeFrameListeners.get(metadata.requestId);
      if (listener) {
        const CpuVideoFrame = (globalThis as { VideoFrame?: NativeCpuVideoFrameConstructor }).VideoFrame;
        if (typeof CpuVideoFrame !== 'function') throw new TypeError('native_cpu_video_frame_unavailable');
        frame = new CpuVideoFrame(data, {
          format: 'NV12', codedWidth: metadata.width, codedHeight: metadata.height,
          displayWidth: metadata.width, displayHeight: metadata.height, timestamp: metadata.timestamp,
          layout: [{ offset: 0, stride: metadata.width }, { offset: metadata.width * metadata.height, stride: metadata.width }],
          colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
          // Implementations may consume the ArrayBuffer; correctness also holds
          // when the constructor copies it and ignores this transfer hint.
          transfer: [data],
        });
        await listener(frame, metadata);
      }
    } catch (error) {
      console.warn('[native-screen] renderer_cpu_frame_error', error instanceof Error ? error.name : 'unknown');
      stopReceiver();
    } finally {
      try { frame?.close(); }
      catch { stopReceiver(); }
      // Main owns the slot bytes independently. Only this CPU acknowledgment
      // returns that credit; it never participates in GPU release permits.
      ipcRenderer.send('cove:native-screen:cpu-frame-done', metadata);
    }
  });
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, metadata: NativeScreenFrame) => {
    let frame: ReturnType<typeof imported.getVideoFrame> | undefined;
    // A malformed message is never sent by the main broker. Retire the import
    // without issuing a slot credit rather than trusting unvalidated metadata.
    if (!nativeFrameValid(metadata) || metadata.storage !== undefined) { imported.release(); return; }
    const key = nativePermitKey(metadata);
    let permitTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const permit = new Promise<void>((resolve) => {
      if (nativeEarlyPermits.delete(key)) { resolve(); return; }
      nativeReleasePermits.set(key, resolve);
      permitTimer = setTimeout(() => {
        timedOut = true;
        nativeReleasePermits.delete(key);
        // No credit is fabricated on a timeout. Main retires this session.
        void ipcRenderer.invoke('cove:native-screen:stop', metadata.requestId, 'receiver_failed').catch(() => {});
        resolve();
      }, 1500);
    });
    try {
      const listener = nativeFrameListeners.get(metadata.requestId);
      if (listener) {
        frame = imported.getVideoFrame();
        await listener(frame, metadata);
      }
    } catch (error) {
      console.warn('[native-screen] renderer_frame_callback_error', error instanceof Error ? error.name : 'unknown');
      void ipcRenderer.invoke('cove:native-screen:stop', metadata.requestId, 'receiver_failed').catch(() => {});
    } finally {
      frame?.close();
      await permit;
      clearTimeout(permitTimer);
      nativeReleasePermits.delete(key);
      // sendSharedTexture owns another main-process reference until transfer
      // completion. On timeout the entire session is retired, never reused.
      imported.release();
      if (timedOut) nativeEarlyPermits.delete(key);
    }
  });
}
contextBridge.exposeInMainWorld('coveNativeScreen', {
  supported: nativeEnabled,
  start: (requestId: string, options: NativeScreenOptions): Promise<NativeScreenStartResult> =>
    nativeEnabled && nativeRequestId(requestId)
      ? ipcRenderer.invoke('cove:native-screen:start', requestId, options)
      : Promise.resolve({ ok: false, reason: 'unavailable' }),
  stop: (requestId: string, fault?: 'renderer_failed' | 'receiver_failed'): Promise<boolean> => nativeRequestId(requestId) &&
    (fault === undefined || fault === 'renderer_failed' || fault === 'receiver_failed')
    ? ipcRenderer.invoke('cove:native-screen:stop', requestId, fault) : Promise.resolve(false),
  onFrame: (requestId: string, listener: (frame: unknown, metadata: NativeScreenFrame) => Promise<void>) => {
    if (!nativeRequestId(requestId) || typeof listener !== 'function') return () => {};
    nativeFrameListeners.set(requestId, listener);
    return () => { if (nativeFrameListeners.get(requestId) === listener) nativeFrameListeners.delete(requestId); };
  },
  onEnded: (requestId: string, listener: (reason: string) => void) => {
    if (!nativeRequestId(requestId) || typeof listener !== 'function') return () => {};
    nativeEndListeners.set(requestId, listener);
    return () => { if (nativeEndListeners.get(requestId) === listener) nativeEndListeners.delete(requestId); };
  },
});

contextBridge.exposeInMainWorld('coveServerAccess', {
  get: (server: string, email: string) => ipcRenderer.invoke('cove:server-access:get', server, email),
  set: (server: string, email: string, grant: { accessToken: string; expiresAt: number }) => ipcRenderer.invoke('cove:server-access:set', server, email, grant),
  remove: (server: string, email?: string) => ipcRenderer.invoke('cove:server-access:remove', server, email),
  clear: () => ipcRenderer.invoke('cove:server-access:clear'),
});

contextBridge.exposeInMainWorld('coveAccountPasswords', {
  status: () => ipcRenderer.invoke('cove:account-password:status'),
  get: (server: string, email: string) => ipcRenderer.invoke('cove:account-password:get', server, email),
  set: (server: string, email: string, password: string) => ipcRenderer.invoke('cove:account-password:set', server, email, password),
  remove: (server: string, email: string) => ipcRenderer.invoke('cove:account-password:remove', server, email),
  clear: () => ipcRenderer.invoke('cove:account-password:clear'),
});

contextBridge.exposeInMainWorld('coveAnnotationOverlay', {
  bind: (sessionId: string) => ipcRenderer.invoke('cove:annotation-overlay:bind', sessionId),
  update: (token: string, frame: unknown) => ipcRenderer.invoke('cove:annotation-overlay:update', token, frame),
  setInputActive: (token: string, active: boolean) => ipcRenderer.invoke('cove:annotation-overlay:input-mode', token, active),
  close: (token: string) => ipcRenderer.invoke('cove:annotation-overlay:close', token),
  onFailure: (listener: (event: { token: string; reason: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: { token: string; reason: string }) => listener(event);
    ipcRenderer.on('cove:annotation-overlay:failure', handler);
    return () => ipcRenderer.off('cove:annotation-overlay:failure', handler);
  },
  onInput: (listener: (event: { token: string; input: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: { token: string; input: unknown }) => listener(event);
    ipcRenderer.on('cove:annotation-overlay:input', handler);
    return () => ipcRenderer.off('cove:annotation-overlay:input', handler);
  },
});

contextBridge.exposeInMainWorld("coveUpdater", {
  getState: (): Promise<UpdateState> =>
    ipcRenderer.invoke("cove:update:get-state"),
  checkNow: (): Promise<UpdateState> =>
    ipcRenderer.invoke("cove:update:check"),
  installNow: (): Promise<boolean> => ipcRenderer.invoke("cove:update:install"),
  openLog: (): Promise<boolean> => ipcRenderer.invoke("cove:update:open-log"),
  onState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) =>
      listener(state);
    ipcRenderer.on("cove:update:state", handler);
    return () => ipcRenderer.off("cove:update:state", handler);
  },
});

contextBridge.exposeInMainWorld('coveIntegrity', {
  getState: (): Promise<InstallationIntegrityState> => ipcRenderer.invoke('cove:integrity:get-state'),
  checkNow: (): Promise<InstallationIntegrityState> => ipcRenderer.invoke('cove:integrity:check'),
  downloadRepair: (): Promise<InstallationIntegrityState> => ipcRenderer.invoke('cove:integrity:download'),
  cancel: (): Promise<InstallationIntegrityState> => ipcRenderer.invoke('cove:integrity:cancel'),
  launchRepair: (): Promise<boolean> => ipcRenderer.invoke('cove:integrity:launch'),
  openRelease: (): Promise<boolean> => ipcRenderer.invoke('cove:integrity:open-release'),
  onState: (listener: (state: InstallationIntegrityState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: InstallationIntegrityState) => listener(state);
    ipcRenderer.on('cove:integrity:state', handler);
    return () => ipcRenderer.off('cove:integrity:state', handler);
  },
});

contextBridge.exposeInMainWorld("coveShell", {
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke("cove:shell:open-external", url),
});

contextBridge.exposeInMainWorld("coveWindow", {
  minimize: (): Promise<boolean> => ipcRenderer.invoke("cove:window:minimize"),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("cove:window:toggle-maximize"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("cove:window:is-maximized"),
  close: (): Promise<boolean> => ipcRenderer.invoke("cove:window:close"),
  focus: (): Promise<boolean> => ipcRenderer.invoke("cove:window:focus"),
  onState: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
    ipcRenderer.on("cove:window-state", handler);
    return () => ipcRenderer.off("cove:window-state", handler);
  },
  onResize: (listener: (active: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, active: boolean) => listener(active);
    ipcRenderer.on("cove:window-resizing", handler);
    return () => ipcRenderer.off("cove:window-resizing", handler);
  },
});

contextBridge.exposeInMainWorld("coveClipboard", {
  writeText: (value: string): Promise<boolean> =>
    ipcRenderer.invoke("cove:clipboard:write-text", value),
  writeImage: (value: Uint8Array, mimeType: "image/png" | "image/gif", pngFallback?: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke("cove:clipboard:write-image", value, mimeType, pngFallback),
  readGif: (): Promise<Uint8Array | null> =>
    ipcRenderer.invoke("cove:clipboard:read-gif"),
});

contextBridge.exposeInMainWorld("coveSecurity", {
  setServerCertificateException: (
    serverUrl: string,
    enabled: boolean,
  ): Promise<string | null> =>
    ipcRenderer.invoke(
      "cove:security:set-server-certificate-exception",
      serverUrl,
      enabled,
    ),
  resolveServerAddresses: (hostname: string): Promise<string[]> =>
    ipcRenderer.invoke("cove:security:resolve-server-addresses", hostname),
});

contextBridge.exposeInMainWorld("coveRemoteControl", {
  supported: process.platform === "win32",
  setActive: (sessionId: string | null): Promise<RemoteControlActivation> =>
    ipcRenderer.invoke("cove:remote-control:set-active", sessionId),
  sendInput: (sessionId: string, input: RemoteControlInput): Promise<boolean> =>
    ipcRenderer.invoke("cove:remote-control:input", sessionId, input),
  onEmergencyStop: (listener: (reason?: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, reason?: string) => listener(reason);
    ipcRenderer.on("cove:remote-control:emergency-stop", handler);
    return () => ipcRenderer.off("cove:remote-control:emergency-stop", handler);
  },
});

contextBridge.exposeInMainWorld("coveAudioLatencyProfile",
  process.env.COVE_AUDIO_LATENCY_PROFILE === "legacy" ? "legacy" : "adaptive");

function onAudioChunk(channel: string, listener: (chunk: Uint8Array) => void) {
  const handler = (_event: Electron.IpcRendererEvent, chunk: Uint8Array, sequence?: number) => {
    try { listener(chunk); }
    finally { if (typeof sequence === "number") ipcRenderer.send(`${channel}:ack`, sequence); }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld("coveApplicationAudio", {
  listSources: () => ipcRenderer.invoke("cove:application-audio:list"),
  start: (sourceId: string) =>
    ipcRenderer.invoke("cove:application-audio:start", sourceId),
  stop: () => ipcRenderer.invoke("cove:application-audio:stop"),
  onChunk: (listener: (chunk: Uint8Array) => void) => {
    return onAudioChunk("cove:application-audio:chunk", listener);
  },
});

// Screen sharing uses a native process-loopback capture in the main process.
// Its exclude mode removes Cove's own rendered audio from the desktop mix.
contextBridge.exposeInMainWorld("coveScreenAudio", {
  start: () => ipcRenderer.invoke("cove:screen-audio:start"),
  stop: () => ipcRenderer.invoke("cove:screen-audio:stop"),
  onChunk: (listener: (chunk: Uint8Array) => void) => {
    return onAudioChunk("cove:screen-audio:chunk", listener);
  },
});

contextBridge.exposeInMainWorld("coveSystemAudio", {
  start: () => ipcRenderer.invoke("cove:system-audio:start"),
  stop: () => ipcRenderer.invoke("cove:system-audio:stop"),
  onChunk: (listener: (chunk: Uint8Array) => void) => {
    return onAudioChunk("cove:system-audio:chunk", listener);
  },
});
