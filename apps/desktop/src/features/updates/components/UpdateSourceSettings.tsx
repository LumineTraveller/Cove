import { useEffect, useState } from 'react';
import { Check, Download, LoaderCircle } from 'lucide-react';
import type { UpdateSettings } from '../../../../electron/update-settings-types';

export function UpdateSourceSettings({ settings, busy, loadError, onSaved, onGithubCheck }: {
  settings: UpdateSettings | null;
  busy: boolean;
  loadError: string;
  onSaved(settings: UpdateSettings): void;
  onGithubCheck(): void;
}) {
  const [draft, setDraft] = useState(settings?.serverUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  useEffect(() => { setDraft(settings?.serverUrl ?? ''); }, [settings?.serverUrl]);
  const unavailable = !settings || busy || saving;

  const save = async () => {
    if (unavailable) return;
    setSaving(true);
    setFeedback(null);
    try {
      const updater = window.coveUpdater;
      if (!updater?.saveSettings) throw new Error('请重启客户端后设置更新地址。');
      const result = await updater.saveSettings(draft);
      if (!result.ok) throw new Error(result.error ?? '保存失败，请重试。');
      setDraft(result.settings.serverUrl);
      onSaved(result.settings);
      setFeedback({ error: false, message: result.settings.automaticEnabled
        ? '已保存，自动更新优先使用此服务器。' : '已保存，自动更新已关闭。' });
    } catch (error) {
      setFeedback({ error: true, message: error instanceof Error ? error.message : '保存失败，请重试。' });
    } finally { setSaving(false); }
  };

  return <section className="update-source-settings" aria-label="更新来源设置">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="field" htmlFor="update-server-url">
        <span>更新服务器地址</span>
        <input id="update-server-url" type="url" value={draft} placeholder="https://updates.example.com"
          autoComplete="off" spellCheck={false} disabled={unavailable}
          aria-describedby="update-server-help"
          onChange={event => { setDraft(event.target.value); setFeedback(null); }} />
      </label>
      <p id="update-server-help" className="update-source-help">
        留空时不自动检查或下载更新，仍可手动使用 GitHub。填写并保存后，优先从服务器更新，失败时回退 GitHub。
      </p>
      <p className="update-source-help">请填写 HTTPS 根地址或路径前缀；检查清单使用其下的 /releases/latest.json。</p>
      <div className="update-source-actions">
        <button type="submit" className="update-secondary-action" disabled={unavailable || draft === settings?.serverUrl}>
          {saving ? <LoaderCircle size={15} className="update-status-spin" /> : <Check size={15} />}
          {saving ? '保存中…' : '保存地址'}
        </button>
        <button type="button" className="update-secondary-action" disabled={busy || saving || !settings}
          onClick={onGithubCheck}><Download size={15} />GitHub 检查并下载</button>
      </div>
      {!settings && !loadError && <p className="update-source-help" role="status">正在读取更新设置…</p>}
      {loadError && <p className="update-action-error" role="alert">{loadError}</p>}
      {feedback && <p className={feedback.error ? 'update-action-error' : 'update-source-feedback'}
        role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    </form>
  </section>;
}
