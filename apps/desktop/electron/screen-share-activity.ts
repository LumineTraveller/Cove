import type { IpcMain, IpcMainEvent, WebContents } from 'electron';
import { acquireNativeScreenRendererActivity } from './native-screen-renderer-activity';

export function registerScreenShareActivity(
  ipc: Pick<IpcMain, 'on' | 'off'>,
  isTrusted: (event: IpcMainEvent) => boolean,
) {
  const active = new Map<WebContents, { id: number; dispose(): void }>();
  const channel = 'cove:screen-share:activity';
  const receive = (event: IpcMainEvent, id: unknown, enabled: unknown) => {
    try { if (!isTrusted(event)) return; } catch { return; }
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof enabled !== 'boolean') return;
    const target = event.sender, previous = active.get(target);
    if (!enabled) {
      if (previous && previous.id === id) previous.dispose();
      return;
    }
    if (previous?.id === id) return;
    const release = acquireNativeScreenRendererActivity(target);
    if (!release) return;
    // Acquire the successor before releasing its predecessor; scheduling must
    // remain active during a handover and delayed releases cannot undo it.
    previous?.dispose();
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      target.off('destroyed', dispose);
      target.off('render-process-gone', dispose);
      target.off('did-start-navigation', navigating);
      if (active.get(target)?.id === id) active.delete(target);
      release();
    };
    const navigating = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame) dispose();
    };
    active.set(target, { id: id as number, dispose });
    target.once('destroyed', dispose);
    target.once('render-process-gone', dispose);
    target.on('did-start-navigation', navigating);
  };
  ipc.on(channel, receive);
  return () => { ipc.off(channel, receive); [...active.values()].forEach(entry => entry.dispose()); };
}
