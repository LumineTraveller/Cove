import { createRoot } from 'react-dom/client';
import { InstallationIntegrityPanel } from '../../src/features/integrity/components/InstallationIntegrityPanel';
import { UpdateCenter } from '../../src/features/updates/components/UpdateCenter';
import type { InstallationIntegrityApi, InstallationIntegrityState } from '../../electron/integrity-state';
import '../../src/styles/ui-v2.css';
import './installation-integrity-fixture.css';

const base: InstallationIntegrityState = { status: 'idle', version: '2.0.2', platform: 'win32', arch: 'x64' };
let state = base;
const listeners = new Set<(next: InstallationIntegrityState) => void>();
const calls = { checks: 0, downloads: 0, launches: 0, cancels: 0, releases: 0 };
const emit = (next: Partial<InstallationIntegrityState>) => {
  state = { ...base, ...next };
  listeners.forEach((listener) => listener(state));
  return state;
};
const api: InstallationIntegrityApi = {
  async getState() { return state; },
  async checkNow() { calls.checks++; return emit({ status: 'checking', checkedFiles: 20, totalFiles: 80 }); },
  async downloadRepair() { calls.downloads++; return emit({ status: 'downloading', repairAvailable: true, progress: { transferred: 40_000_000, total: 100_000_000, percent: 40 } }); },
  async cancel() { calls.cancels++; return emit({ status: 'idle' }); },
  async launchRepair() {
    calls.launches++;
    // Simulate native cancellation. This fixture never launches an installer.
    emit({ status: 'downloaded', repairAvailable: true });
    return false;
  },
  async openRelease() { calls.releases++; return true; },
  onState(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

Object.assign(window, { integrityFixture: { emit, calls } });

createRoot(document.getElementById('root')!).render(
  <div className="integrity-fixture global-settings">
    <aside><h2>设置</h2><button className="active" type="button">检查更新</button></aside>
    <main>
      <header><h2>检查更新</h2><small>隔离状态预览</small></header>
      <div className="settings-page update-settings-page">
        <UpdateCenter embedded serverURL="" />
        <InstallationIntegrityPanel api={api} />
      </div>
    </main>
  </div>,
);
