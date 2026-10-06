import { app, BrowserWindow, globalShortcut, screen, type DesktopCapturerSource, type Rectangle, type WebContents } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { validOverlayFrame, type AnnotationOverlayFrame } from './annotation-overlay-state';
import { validOverlayInput, type AnnotationOverlayInput } from './annotation-overlay-input';

const EMERGENCY_EXIT = 'Control+Alt+Shift+A';

/** Own-source drawing input and a local mirror. No capture, OS input injection or socket. */
export class AnnotationOverlayController {
  private source: Pick<DesktopCapturerSource, 'id' | 'display_id'> | null = null;
  private pendingSource: Pick<DesktopCapturerSource, 'id' | 'display_id'> | null = null;
  private token: string | null = null;
  private win: BrowserWindow | null = null;
  private geometry: ChildProcessWithoutNullStreams | null = null;
  private frame: AnnotationOverlayFrame = { strokes: [], lasers: [] };
  private loaded = false;
  private failed = false;
  private bounds: Rectangle | null = null;
  private targetVisible = true;
  private inputActive = false;
  private escapeRegistered = false;
  private emergencyRegistered = false;

  constructor(private readonly failure: (token: string, reason: string) => void = () => {},
    private readonly input: (token: string, event: AnnotationOverlayInput) => void = () => {}) {}

  setCaptureSource(source: Pick<DesktopCapturerSource, 'id' | 'display_id'> | null) {
    this.pendingSource = source;
    if (!source) this.close();
  }

  bind(sessionId: unknown): { token?: string; error?: string } {
    // Older Windows turns protected windows into black capture rectangles.
    if (process.platform !== 'win32' || Number(release().split('.')[2]) < 19041)
      return { error: '桌面批注覆盖层需要 Windows 10 2004 或更新版本。' };
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !this.pendingSource)
      return { error: '无法定位本次共享的采集源，桌面批注覆盖层未启动。' };
    this.destroyWindow();
    this.source = this.pendingSource;
    this.token = randomUUID();
    this.failed = false;
    this.frame = { strokes: [], lasers: [] };
    return { token: this.token };
  }

  update(token: unknown, frame: unknown): boolean {
    if (!this.token || token !== this.token || this.failed || !validOverlayFrame(frame)) return false;
    this.frame = frame;
    if (!frame.strokes.length && !frame.lasers.length && !this.inputActive) this.destroyWindow();
    else {
      if (!this.win) this.createWindow();
      this.paint();
    }
    return !this.failed;
  }

  setInputActive(token: unknown, active: unknown): boolean {
    if (!this.token || token !== this.token || this.failed || typeof active !== 'boolean') return false;
    if (active === this.inputActive) return true;
    if (active) {
      this.emergencyRegistered = globalShortcut.register(EMERGENCY_EXIT, this.exitInput);
      if (!this.emergencyRegistered) {
        this.failure(this.token, '退出快捷键不可用，桌面绘画未接管鼠标。');
        return false;
      }
      this.escapeRegistered = globalShortcut.register('Escape', this.exitInput);
      this.inputActive = true;
      if (!this.win) this.createWindow();
      this.applyInputFlags(); this.paint();
    } else {
      this.releaseInput();
      if (!this.frame.strokes.length && !this.frame.lasers.length) this.destroyWindow();
      else this.paint();
    }
    return !this.failed && active === this.inputActive;
  }

  handleInput(sender: WebContents, token: unknown, event: unknown): boolean {
    if (!this.inputActive || !this.token || token !== this.token || sender !== this.win?.webContents || !validOverlayInput(event)) return false;
    if (event.type === 'exit') this.exitInput();
    else this.input(this.token, event);
    return true;
  }

  private exitInput = () => {
    if (!this.inputActive) return;
    const token = this.token;
    this.releaseInput();
    if (!this.frame.strokes.length && !this.frame.lasers.length) this.destroyWindow();
    else this.paint();
    if (token) this.input(token, { type: 'exit' });
  };

  private releaseInput() {
    this.inputActive = false;
    if (this.escapeRegistered) globalShortcut.unregister('Escape');
    if (this.emergencyRegistered) globalShortcut.unregister(EMERGENCY_EXIT);
    this.escapeRegistered = false; this.emergencyRegistered = false;
    this.applyInputFlags();
  }

  private applyInputFlags() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(!this.inputActive);
    this.win.setFocusable(this.inputActive);
  }

  close(token?: unknown) {
    if (token !== undefined && token !== this.token) return;
    this.token = null;
    this.source = null;
    this.frame = { strokes: [], lasers: [] };
    this.destroyWindow();
  }

  private fail(reason: string) {
    this.failed = true;
    const token = this.token;
    this.destroyWindow();
    if (token) this.failure(token, reason);
  }

  private refreshDisplay = () => {
    if (!this.source?.id.startsWith('screen:')) return;
    const display = screen.getAllDisplays().find(item => String(item.id) === this.source?.display_id);
    if (!display) { this.fail('共享显示器已移除或无法定位，桌面批注已隐藏。'); return; }
    this.place(display.bounds, true);
  };

  private createWindow() {
    const win = new BrowserWindow({ show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', focusable: false, skipTaskbar: true,
      hasShadow: false, resizable: false, movable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, partition: 'cove-annotation-overlay',
        preload: path.join(__dirname, 'annotation-overlay-preload.js') } });
    this.win = win;
    this.loaded = false;
    this.bounds = null;
    this.targetVisible = false;
    win.setContentProtection(true);
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    this.applyInputFlags();
    win.on('blur', this.exitInput);
    win.on('closed', () => { if (this.win === win) this.close(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => this.fail('桌面批注窗口已退出，请停止并重新共享。'));
    win.webContents.once('did-finish-load', () => {
      if (this.win !== win) return;
      this.loaded = true;
      this.paint();
    });
    void win.loadFile(path.join(__dirname, '../electron/annotation-overlay.html')).catch(() => {
      if (this.win === win) this.fail('无法加载桌面批注窗口。');
    });
    if (this.source?.id.startsWith('screen:')) {
      screen.on('display-metrics-changed', this.refreshDisplay);
      screen.on('display-removed', this.refreshDisplay);
      this.refreshDisplay();
    } else this.trackWindow();
  }

  private trackWindow() {
    const hwnd = this.source?.id.match(/^window:(\d+):/i)?.[1];
    const executable = app.isPackaged ? path.join(process.resourcesPath, 'annotation-window-helper.exe')
      : path.join(app.getAppPath(), 'build/annotation-window-helper.exe');
    if (!hwnd || !existsSync(executable)) { this.fail('无法定位共享窗口，桌面批注未显示。'); return; }
    const helper = spawn(executable, [hwnd, String(process.pid)], { windowsHide: true, stdio: 'pipe' });
    this.geometry = helper;
    helper.stderr.resume();
    let output = '';
    helper.stdout.on('data', (chunk: Buffer) => {
      if (this.geometry !== helper) return;
      output += chunk.toString('utf8');
      if (output.length > 8192) { this.fail('共享窗口位置响应无效。'); return; }
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const value = JSON.parse(line) as { closed?: boolean; visible: boolean; sourceVisible?: boolean; bounds: Rectangle };
          if (value.closed) { this.close(); return; }
          const rect = value.bounds;
          if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)
            { this.place(null, false); continue; }
          this.place(screen.screenToDipRect(null, rect), value.visible === true ||
            (this.inputActive && value.sourceVisible === true && Boolean(this.win?.isFocused())));
        } catch { this.fail('无法读取共享窗口位置。'); return; }
      }
    });
    helper.on('error', () => { if (this.geometry === helper) this.fail('共享窗口定位组件无法启动。'); });
    // `close` waits for stdout, so the final source-closed message is processed.
    helper.on('close', code => {
      if (this.geometry !== helper) return;
      if (code === 0) this.close();
      else this.fail('共享窗口定位组件已退出。');
    });
  }

  private place(bounds: Rectangle | null, visible: boolean) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.targetVisible = visible;
    if (bounds && (!this.bounds || Object.keys(bounds).some(key =>
      bounds[key as keyof Rectangle] !== this.bounds![key as keyof Rectangle]))) {
      this.bounds = bounds;
      win.setBounds(bounds);
    }
    this.paint();
  }

  private paint() {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.loaded) return;
    win.webContents.send('cove:annotation-overlay:mode', { token: this.token, active: this.inputActive,
      sourceKind: this.source?.id.startsWith('screen:') ? 'screen' : 'window' });
    win.webContents.send('cove:annotation-overlay:frame', this.frame);
    if (this.bounds && this.targetVisible) {
      if (this.inputActive) { win.show(); if (!win.isFocused()) win.focus(); }
      else win.showInactive();
    }
    else win.hide();
  }

  private destroyWindow() {
    this.releaseInput();
    screen.removeListener('display-metrics-changed', this.refreshDisplay);
    screen.removeListener('display-removed', this.refreshDisplay);
    const helper = this.geometry;
    this.geometry = null;
    helper?.kill();
    const win = this.win;
    this.win = null;
    this.loaded = false;
    this.bounds = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
