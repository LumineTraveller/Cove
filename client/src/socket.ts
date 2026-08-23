import { io } from 'socket.io-client';

const CLIENT_ID_KEY = 'cove_client_id';

/**
 * 持久设备身份用于恢复房主权限。它不会显示给其他成员，也不会随着“退出登录”清除。
 */
export function getClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function normalizeURL(url: string): string {
  const s = url.trim();
  if (!s) return 'http://localhost:3001';
  if (!s.startsWith('http://') && !s.startsWith('https://')) return `http://${s}`;
  return s;
}

export function getServerURL(): string {
  // 用户手动设置的地址优先级最高
  const stored = localStorage.getItem('cove_server_url');
  if (stored) return normalizeURL(stored);
  // 其次用编译时的环境变量（打包给朋友时的默认地址）
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;
  if (window.location.protocol !== 'file:' && window.location.hostname !== 'localhost') {
    return window.location.origin;
  }
  return 'http://localhost:3001';
}

// socket 在模块加载时创建，login 后 reload 页面使新 URL 生效
export const socket = io(getServerURL(), { autoConnect: false });
