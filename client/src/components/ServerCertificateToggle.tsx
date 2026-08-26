import { ShieldAlert } from 'lucide-react';
import { normalizeHttpsOrigin } from '../serverCertificate';

interface Props {
  serverUrl: string;
  checked: boolean;
  onChange(checked: boolean): void;
}

export function ServerCertificateToggle({ serverUrl, checked, onChange }: Props) {
  const available = normalizeHttpsOrigin(serverUrl) !== null;
  return (
    <label className={`mt-3 flex gap-3 rounded-xl border px-3.5 py-3 transition ${available ? 'cursor-pointer border-amber-300/15 bg-amber-300/[0.06] hover:bg-amber-300/[0.09]' : 'cursor-not-allowed border-white/[0.06] bg-white/[0.025] opacity-45'}`}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 flex-shrink-0 accent-amber-300"
        checked={available && checked}
        disabled={!available}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-white/70"><ShieldAlert size={15} className="text-amber-200/70" />允许此服务器使用不受信任的证书</span>
        <span className="mt-1 block text-xs leading-relaxed text-white/35">
          {available
            ? '仅对当前 HTTPS 域名和端口生效。只在使用 SakuraFrp 自动 HTTPS 时开启。'
            : '此选项仅适用于 https:// 开头的服务器地址。'}
        </span>
      </span>
    </label>
  );
}
