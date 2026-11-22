import fs from 'node:fs';
import path from 'node:path';

import { normalizeUpdateServerUrl } from './update-server-url';
import type { UpdateSettings } from './update-settings-types';
export { normalizeUpdateServerUrl } from './update-server-url';
export type { UpdateSettings, UpdateSettingsResult } from './update-settings-types';

export function settingsForServerUrl(serverUrl: string): UpdateSettings {
  return { serverUrl, automaticEnabled: serverUrl.length > 0 };
}

/** A separate userData file: login/account settings never select an update source. */
export class UpdateSettingsStore {
  private readonly file: string;
  constructor(userDataDir: string) { this.file = path.join(userDataDir, 'update-settings.json'); }

  load(): UpdateSettings {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return settingsForServerUrl('');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { schema?: unknown; serverUrl?: unknown };
      return settingsForServerUrl(data.schema === 1 ? normalizeUpdateServerUrl(data.serverUrl) ?? '' : '');
    } catch { return settingsForServerUrl(''); }
  }

  save(serverUrl: string): void {
    if (normalizeUpdateServerUrl(serverUrl) !== serverUrl) throw new Error('Invalid update server URL');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, serverUrl }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* already renamed, or no temporary file */ }
    }
  }
}
