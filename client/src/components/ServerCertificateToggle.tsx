import { ShieldAlert } from 'lucide-react';
import { normalizeHttpsOrigin } from '../serverCertificate';

interface Props {
  serverUrl: string;
  checked: boolean;
  onChange(checked: boolean): void;
  tone?: 'dark' | 'light';
}

export function ServerCertificateToggle({ serverUrl, checked, onChange, tone = 'dark' }: Props) {
  const available = normalizeHttpsOrigin(serverUrl) !== null;
  const light = tone === 'light';
  return (
    <label className={`server-certificate-toggle mt-3 flex gap-3 rounded-xl border px-3.5 py-3 transition ${light ? 'server-certificate-toggle-light' : ''} ${available ? (light ? 'cursor-pointer' : 'cursor-pointer border-amber-300/15 bg-amber-300/[0.06] hover:bg-amber-300/[0.09]') : (light ? 'cursor-not-allowed opacity-55' : 'cursor-not-allowed border-white/[0.06] bg-white/[0.025] opacity-45')}`}>
      <input
        type="checkbox"
        className={`mt-0.5 h-4 w-4 flex-shrink-0 ${light ? 'accent-blue-600' : 'accent-amber-300'}`}
        checked={available && checked}
        disabled={!available}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className={`flex items-center gap-1.5 text-sm font-medium ${light ? 'text-slate-700' : 'text-white/70'}`}><ShieldAlert size={15} className={light ? 'text-amber-600' : 'text-amber-200/70'} />允许此服务器使用不受信任的证书</span>
        <span className={`mt-1 block text-xs leading-relaxed ${light ? 'text-slate-500' : 'text-white/35'}`}>
          {available
            ? '仅对当前 HTTPS 域名和端口生效。只在使用 SakuraFrp 自动 HTTPS 时开启。'
            : '此选项仅适用于 https:// 开头的服务器地址。'}
        </span>
      </span>
    </label>
  );
}
