// Open /tests/ui/update-center.html on the client Vite development server.
// Real UI, simulated updater bridge: no network download or installer is run.
import { createRoot } from 'react-dom/client';
import { UpdateCenter } from '../../src/components/UpdateCenter';
import { openUpdateCenter, type UpdateState } from '../../src/update';
import '../../src/index.css';

let current: UpdateState = { status: 'idle' };
const listeners = new Set<(state: UpdateState) => void>();
const emit = (next: UpdateState) => {
  current = { version: '0.8.1', source: 'gitee', sourceLabel: 'Gitee', stageStartedAt: Date.now(), lastActivityAt: Date.now(), ...next };
  listeners.forEach(listener => listener(current));
};
window.coveUpdater = {
  getState: async () => current,
  checkNow: async () => current,
  installNow: async () => {
    if (current.status !== 'downloaded') return false;
    emit({ ...current, status: 'installing', stageStartedAt: Date.now(), lastActivityAt: Date.now(), message: '正在请求启动安装并退出 Cove。（测试，不会运行安装程序）' });
    return true;
  },
  openLog: async () => { document.getElementById('result')!.textContent = '已请求打开更新日志'; return true; },
  onState: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
window.coveShell = { openExternal: async url => { document.getElementById('result')!.textContent = url; return true; } };
const total = 100 * 1024 * 1024;
const scenarios: Array<[string, () => UpdateState]> = [
  ['检查', () => ({ status: 'checking', message: '正在检查更新服务器…' })],
  ['准备', () => ({ status: 'available', message: '发现新版本，准备下载。' })],
  ['传输 99.99%', () => ({ status: 'downloading', percent: 99.99, transferred: total * 0.9999, total, bytesPerSecond: 204800, message: '正在传输更新文件，不会中断当前通话。' })],
  ['等待数据 45 秒', () => ({ status: 'downloading', percent: 58, transferred: total * 0.58, total, bytesPerSecond: 204800, stageStartedAt: Date.now() - 60000, lastActivityAt: Date.now() - 45000 })],
  ['100% 等待就绪', () => ({ status: 'finalizing', percent: 100, transferred: total, total, stageStartedAt: Date.now() - 45000, lastActivityAt: Date.now() - 45000, message: '当前传输已完成，正在等待更新器完成校验与文件准备；尚不可安装。' })],
  ['校验失败', () => ({ status: 'error', failedStage: 'finalizing', percent: 100, transferred: total, total, errorCode: 'ERR_CHECKSUM_MISMATCH', errorDetail: 'sha512 checksum mismatch (simulated)', message: '传输结束，但校验或安装文件准备失败；请重试或手动下载。' })],
  ['安装就绪', () => ({ status: 'downloaded', percent: 100, transferred: total, total, message: '更新器已确认安装包就绪。可以立即重启安装，或退出 Cove 时安装。' })],
  ['启动安装等待', () => ({ status: 'installing', stageStartedAt: Date.now() - 20000, lastActivityAt: Date.now() - 20000 })],
];

createRoot(document.getElementById('root')!).render(<>
  <main style={{ padding: 24, color: '#ddd', maxWidth: 320 }}>
    <h1>更新组件测试</h1>
    <p>仅模拟事件，不会下载或安装。</p>
    <button style={{ display: 'block', padding: 10 }} onClick={openUpdateCenter}>打开更新面板</button>
    {scenarios.map(([label, scenario]) => <button key={label} style={{ display: 'block', padding: 10 }} onClick={() => emit(scenario())}>{label}</button>)}
    <output id="result" style={{ wordBreak: 'break-all' }} />
  </main>
  <UpdateCenter />
</>);
