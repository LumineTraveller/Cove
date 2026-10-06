import { normalizeLoginServer } from './accountAuth';
export interface PasswordMemoryResult { available: boolean; ok: boolean; password?: string | null }
export const PASSWORD_MEMORY_UNAVAILABLE = '当前环境无法安全记住账号密码，请手动填写；密码不会保存为明文。';
export const PASSWORD_MEMORY_FAILED = '无法安全读取或保存账号密码，请手动填写或重试。';
const unsupported = { available: false, ok: false };
const normalize = (server: string, email: string) => [normalizeLoginServer(server), email.trim().toLowerCase()] as const;
export async function passwordMemoryStatus(): Promise<PasswordMemoryResult> {
  try { return await window.coveAccountPasswords?.status() ?? unsupported; } catch { return unsupported; }
}
export async function readAccountPassword(server: string, email: string): Promise<PasswordMemoryResult> {
  try { return await window.coveAccountPasswords?.get(...normalize(server, email)) ?? unsupported; } catch { return unsupported; }
}
export async function saveAuthenticatedAccountPassword(server: string, email: string, password: string, remember: boolean): Promise<PasswordMemoryResult> {
  if (!remember) return { available: false, ok: true };
  try { return await window.coveAccountPasswords?.set(...normalize(server, email), password) ?? unsupported; } catch { return unsupported; }
}
export async function removeAccountPassword(server: string, email: string): Promise<PasswordMemoryResult> {
  if (!window.coveAccountPasswords) return { available: false, ok: true };
  try { return await window.coveAccountPasswords.remove(...normalize(server, email)); } catch { return unsupported; }
}
export async function clearAccountPasswords(): Promise<PasswordMemoryResult> {
  if (!window.coveAccountPasswords) return { available: false, ok: true };
  try { return await window.coveAccountPasswords.clear(); } catch { return unsupported; }
}
