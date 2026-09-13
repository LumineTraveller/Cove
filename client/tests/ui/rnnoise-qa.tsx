import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MicrophoneNoiseControl } from '../../src/components/MicrophoneNoiseControl';
import type { MicrophoneNoiseMode } from '../../src/microphoneCandidate';
import '../../src/ui-v2.css';

function Fixture() {
  const [mode, setMode] = useState<MicrophoneNoiseMode>('system');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fail, setFail] = useState(false);
  const [dark, setDark] = useState(false);
  return <main className="global-settings" style={{ display: 'block', width: '100%', maxWidth: 520, height: 'auto', margin: '24px auto', padding: 16 }}>
    <h2>音频设备 · 组件测试</h2>
    <div className="settings-page" style={{ padding: 0 }}>
      <MicrophoneNoiseControl mode={mode} busy={busy} disabled={false} error={error}
        onChange={async (next) => {
          setBusy(true); setError(null);
          await new Promise((resolve) => setTimeout(resolve, 350));
          if (fail && next === 'rnnoise') { setMode('system'); setError('RNNoise 未启用，已回退到系统降噪：测试模拟的模型加载失败'); }
          else setMode(next);
          setBusy(false);
        }} />
      <hr />
      <label><input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />模拟加载失败（仅测试夹具）</label>
      <button onClick={() => {
        setDark(!dark); document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      }}>切换测试主题</button>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
