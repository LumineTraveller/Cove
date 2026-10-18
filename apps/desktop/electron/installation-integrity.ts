import { constants } from 'node:fs';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { InstallationIntegrityIssue, InstallationIntegrityState } from './integrity-state';

const REPOSITORY = 'LumineTraveller/Cove';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_INSTALL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_FILES = 25000;
const MAX_ISSUES = 100;
const METADATA_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const TRUSTED_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const DIGEST = /^sha256:([a-fA-F0-9]{64})$/;
const VERSION = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;
const INTERNET_ZONE_MARKER = '[ZoneTransfer]\r\nZoneId=3\r\n';
const RUNTIME_DIRECTORIES = new Set(['userdata', 'user-data', 'user_data', 'data', 'runtime', 'sessions', 'logs', 'cache', 'caches',
  'crashpad', 'local storage', 'session storage', 'indexeddb', 'service worker', 'gpucache', 'code cache',
  'downloads', 'backups', 'credentials', 'cookies', 'login data', 'network', 'preferences', 'local state',
  '.git', '.aws', '.codex', '.agents', '.cove', 'appdata', 'config', 'accounts', 'settings', 'chats', 'chat',
  'voicepacks', 'soundpacks', 'sound-packs', 'dawngraphitecache', 'dawnwebgpucache', 'blob_storage', 'databases']);
const RUNTIME_FILES = /^(?:uninstall.*\.exe|.*\.lnk|.*\.(?:log|sqlite|sqlite3|db)|(?:accounts?|settings|chats?|credentials)\.json|\.env(?:\..*)?|\.npmrc|\.pypirc)$/i;

export interface InstallationIntegrityOptions {
  isPackaged: boolean;
  platform: string;
  arch: string;
  version: string;
  installRoot: string;
  userDataDir: string;
  /** A dedicated cache, preferably under the OS temporary directory. */
  cacheRoot: string;
  publishState(state: InstallationIntegrityState): void;
  isExternalBusy(): boolean;
  confirmInstall(): Promise<boolean>;
  openInstaller(file: string): Promise<boolean>;
  quit(): void;
  fetchImpl?: typeof fetch;
  /** Tests may replace Windows Attachment Manager's Internet-zone marking. */
  markDownloadedFile?(file: string): Promise<void>;
  /** Synchronous test companion; production always rechecks the Internet zone. */
  verifyDownloadedFile?(file: string): boolean;
}

interface ManifestFile { path: string; size: number; sha256: string }
interface OfficialAsset { name: string; size: number; sha256: string; url: string }
interface OfficialRelease { manifest?: OfficialAsset; installer?: OfficialAsset }
interface Operation { controller: AbortController; previous: InstallationIntegrityState; confirmationPending?: boolean; committed?: boolean }
interface OwnedDirectory { directory: string; directoryStat: Stats }
interface OwnedDownload extends OwnedDirectory {
  file: string; fileStat: Stats; asset: OfficialAsset; inventory: ManifestFile[]; installRootStat: Stats;
}

class IntegrityError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function fail(code: string, message: string): never { throw new IntegrityError(code, message); }
function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) fail('CANCELLED', '操作已取消。');
}
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory();
}
function unchangedFile(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}
function folded(value: string): string { return value.normalize('NFC').toLowerCase(); }
function contained(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function snapshot(state: InstallationIntegrityState): InstallationIntegrityState {
  return { ...state, ...(state.issues ? { issues: state.issues.map(issue => ({ ...issue })) } : {}),
    ...(state.progress ? { progress: { ...state.progress } } : {}) };
}

/** Windows has more aliases than POSIX. Validate before any filesystem access. */
function validateRelativePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.normalize('NFC') ||
      value.includes('\\') || value.startsWith('/') || /[\x00-\x1f\x7f<>:"|?*]/.test(value)) {
    fail('INVALID_MANIFEST', '官方完整性清单包含不安全的文件路径。');
  }
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 || /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      fail('INVALID_MANIFEST', '官方完整性清单包含不安全的文件路径。');
    }
  }
  const segments = value.split('/').map(folded);
  const topLevel = segments[0];
  const resourceEntry = topLevel === 'resources' ? segments[1] : undefined;
  if (segments.some(segment => ['.cove', 'userdata', 'user-data', 'user_data'].includes(segment)) ||
      RUNTIME_DIRECTORIES.has(topLevel) || RUNTIME_FILES.test(topLevel) ||
      (resourceEntry !== undefined && (RUNTIME_DIRECTORIES.has(resourceEntry) || RUNTIME_FILES.test(resourceEntry)))) {
    fail('INVALID_MANIFEST', '完整性清单不能包含用户资料或运行时数据目录。');
  }
  if (folded(value) === 'resources/cove-integrity.json') {
    fail('INVALID_MANIFEST', '完整性清单不能包含其自身。');
  }
}

function parseManifest(bytes: Buffer, version: string): ManifestFile[] {
  let value: any;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_MANIFEST', '官方完整性清单格式无效。'); }
  if (!value || value.schemaVersion !== 1 || value.version !== version || value.platform !== 'win32' || value.arch !== 'x64' ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    fail('INVALID_MANIFEST', '官方完整性清单的版本或架构不匹配。');
  }
  const names = new Set<string>();
  let total = 0;
  return value.files.map((file: any) => {
    if (!file || typeof file !== 'object') fail('INVALID_MANIFEST', '官方完整性清单格式无效。');
    validateRelativePath(file.path);
    const name = folded(file.path);
    if (names.has(name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES ||
        typeof file.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(file.sha256)) {
      fail('INVALID_MANIFEST', '官方完整性清单包含重复路径或无效校验值。');
    }
    names.add(name);
    total += file.size;
    if (total > MAX_INSTALL_BYTES) fail('INVALID_MANIFEST', '官方完整性清单超出大小限制。');
    return { path: file.path, size: file.size, sha256: file.sha256.toLowerCase() };
  });
}

function trustedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { fail('UNTRUSTED_URL', '官方发布下载地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      url.hash || !TRUSTED_HOSTS.has(url.hostname)) {
    fail('UNTRUSTED_URL', '已阻止不受信任的发布下载地址。');
  }
  return url;
}

/** A race is needed even for injected transports that do not implement AbortSignal. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  abortIfNeeded(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new IntegrityError('CANCELLED', '操作已取消。'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function receive(
  fetchImpl: typeof fetch, initialUrl: string, signal: AbortSignal, maximum: number,
  expectedSize?: number, onChunk?: (chunk: Uint8Array, transferred: number) => Promise<void>,
): Promise<Buffer> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, onChunk ? DOWNLOAD_TIMEOUT_MS : METADATA_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    abortIfNeeded(signal);
    let url = trustedUrl(initialUrl);
    let response: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      response = await abortable(fetchImpl(url.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cove-installation-integrity', 'X-GitHub-Api-Version': '2022-11-28' },
      }), controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (hop === 5 || !location) fail('UNTRUSTED_URL', '官方发布下载重定向无效。');
      // Signed GitHub redirect queries are used only in memory, never persisted or exposed.
      url = trustedUrl(new URL(location, url).href);
    }
    if (!response || response.status !== 200) {
      if (response?.status === 404) fail('RELEASE_UNAVAILABLE', '当前版本尚无可核验的官方发布。');
      fail('NETWORK', '无法读取官方发布，请检查网络后重试。');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum ||
        (expectedSize !== undefined && Number(length) !== expectedSize))) {
      fail('SIZE_MISMATCH', '官方发布文件大小与元数据不一致。');
    }
    if (!response.body) fail('NETWORK', '官方发布响应没有可读取的内容。');
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), controller.signal);
      abortIfNeeded(signal);
      if (done) break;
      received += value.byteLength;
      if (received > maximum || (expectedSize !== undefined && received > expectedSize)) {
        fail('SIZE_MISMATCH', '官方发布文件超出预期大小。');
      }
      if (onChunk) await onChunk(value, received);
      else chunks.push(Buffer.from(value));
    }
    if (expectedSize !== undefined && received !== expectedSize) fail('SIZE_MISMATCH', '官方发布文件未完整下载。');
    return onChunk ? Buffer.alloc(0) : Buffer.concat(chunks, received);
  } catch (error) {
    if (timedOut) fail('TIMEOUT', '读取官方发布超时，请稍后重试。');
    if (signal.aborted) fail('CANCELLED', '操作已取消。');
    if (error instanceof IntegrityError) throw error;
    return fail('NETWORK', '无法读取官方发布，请检查网络后重试。');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

async function officialRelease(fetchImpl: typeof fetch, version: string, signal: AbortSignal): Promise<OfficialRelease> {
  const bytes = await receive(fetchImpl, `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`, signal, MAX_JSON_BYTES);
  let release: any;
  try { release = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_RELEASE', '官方发布元数据格式无效。'); }
  if (!release || release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false ||
      !Array.isArray(release.assets) || release.assets.length > 256) {
    fail('INVALID_RELEASE', '官方发布元数据的版本或发布状态无效。');
  }
  const asset = (name: string, maximum: number): OfficialAsset | undefined => {
    const matches = release.assets.filter((item: any) => item?.name === name);
    if (!matches.length) return undefined;
    if (matches.length !== 1) fail('INVALID_RELEASE', '官方发布包含重复附件。');
    const item = matches[0];
    const digest = typeof item.digest === 'string' ? DIGEST.exec(item.digest) : null;
    const url = `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;
    if (item.state !== 'uploaded' || !Number.isSafeInteger(item.id) || item.id <= 0 || !digest ||
        !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > maximum || item.browser_download_url !== url) {
      fail('INVALID_RELEASE', '官方发布附件缺少可信 SHA-256 或有效下载元数据。');
    }
    trustedUrl(url);
    return { name, size: item.size, sha256: digest[1].toLowerCase(), url };
  };
  return { manifest: asset(`Cove-Integrity-${version}-win32-x64.json`, MAX_JSON_BYTES),
    installer: asset(`Cove-Setup-${version}.exe`, MAX_INSTALLER_BYTES) };
}

/** Check every component; lstat detects Windows directory junctions as symbolic links. */
async function safeDirectory(directory: string): Promise<Stats> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  let result = await fs.lstat(root);
  if (result.isSymbolicLink() || !result.isDirectory()) fail('UNSAFE_PATH', '安装或缓存目录不是安全的普通目录。');
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    result = await fs.lstat(current);
    if (result.isSymbolicLink() || !result.isDirectory()) fail('UNSAFE_PATH', '安装或缓存目录包含链接或不安全的目录。');
  }
  if (folded(await fs.realpath(absolute)) !== folded(absolute)) fail('UNSAFE_PATH', '安装或缓存目录指向了其他位置。');
  return result;
}

/** No event-loop reentry between the final path checks and the OS launch request. */
function safeDirectorySync(directory: string): Stats {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  let stat = fsSync.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH', '目录包含不安全的链接。');
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    stat = fsSync.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH', '目录包含不安全的链接。');
  }
  if (folded(fsSync.realpathSync(absolute)) !== folded(absolute)) fail('UNSAFE_PATH', '目录指向了其他位置。');
  return stat;
}

function regularFile(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_PATH', '文件不是安全的单链接普通文件。');
}

async function hashSafeFile(file: string, expectedSize: number, signal: AbortSignal, verifyParents: () => Promise<void>): Promise<{ sha256: string; stat: Stats }> {
  abortIfNeeded(signal);
  await verifyParents();
  const before = await fs.lstat(file);
  regularFile(before);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    regularFile(opened);
    if (!unchangedFile(before, opened)) fail('UNSAFE_PATH', '核验期间文件发生变化，请重试。');
    if (opened.size !== expectedSize) fail('FILE_MODIFIED', '文件大小与官方清单不一致。');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let transferred = 0;
    while (true) {
      abortIfNeeded(signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - transferred + 1), transferred);
      abortIfNeeded(signal);
      if (read.bytesRead === 0) break;
      transferred += read.bytesRead;
      if (transferred > expectedSize) fail('UNSAFE_PATH', '核验期间文件发生变化，请重试。');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    await verifyParents();
    const named = await fs.lstat(file);
    regularFile(named);
    if (transferred !== expectedSize || !unchangedFile(opened, after) || !unchangedFile(after, named) ||
        folded(await fs.realpath(file)) !== folded(path.resolve(file))) {
      fail('UNSAFE_PATH', '核验期间文件或路径发生变化，请重试。');
    }
    return { sha256: hash.digest('hex'), stat: named };
  } finally { await handle?.close(); }
}

async function markInternetDownload(file: string): Promise<void> {
  // No source URL is written: redirected GitHub URLs contain short-lived credentials.
  await fs.writeFile(`${file}:Zone.Identifier`, INTERNET_ZONE_MARKER, { flag: 'wx', mode: 0o600 });
  if (!verifyInternetDownload(file)) throw new Error('MOTW unavailable');
}

function verifyInternetDownload(file: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fsSync.openSync(`${file}:Zone.Identifier`, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const buffer = Buffer.alloc(1025);
    const count = fsSync.readSync(descriptor, buffer, 0, buffer.length, 0);
    return count === Buffer.byteLength(INTERNET_ZONE_MARKER) && buffer.subarray(0, count).toString('utf8') === INTERNET_ZONE_MARKER;
  } catch { return false; }
  finally { if (descriptor !== undefined) fsSync.closeSync(descriptor); }
}

export function createInstallationIntegrityController(options: InstallationIntegrityOptions) {
  const enabled = options.isPackaged && options.platform === 'win32' && options.arch === 'x64' && VERSION.test(options.version);
  const base = { version: options.version, platform: options.platform, arch: options.arch };
  let state: InstallationIntegrityState = { ...base, status: enabled ? 'idle' : 'disabled',
    ...(!enabled ? { message: '安装完整性检查仅支持正式发布的 Windows x64 版本。', repairAvailable: false } : {}) };
  const fetchImpl = options.fetchImpl ?? fetch;
  let active: Operation | undefined;
  let handedOff = false;
  let disposed = false;
  let downloaded: OwnedDownload | undefined;
  const getState = () => snapshot(state);
  const current = (op: Operation) => !disposed && active === op && !op.controller.signal.aborted;
  const publish = (next: InstallationIntegrityState) => {
    if (disposed) return;
    state = snapshot(next);
    options.publishState(snapshot(state));
  };
  const begin = (status: 'checking' | 'downloading' | 'confirming'): Operation | undefined => {
    if (!enabled || disposed || active || handedOff) return undefined;
    if (options.isExternalBusy()) {
      publish({ ...state, message: '更新任务正在进行，请完成后重试。', errorCode: 'BUSY' });
      return undefined;
    }
    const op = { controller: new AbortController(), previous: getState() };
    active = op;
    publish({ ...base, status, repairAvailable: state.repairAvailable });
    return op;
  };
  const finish = (op: Operation) => { if (active === op) active = undefined; };
  const report = (op: Operation, error: unknown, status: 'unavailable' | 'error', repairAvailable = false) => {
    if (!current(op)) return;
    const failure = error instanceof IntegrityError ? error : new IntegrityError(
      ['EACCES', 'EPERM', 'EBUSY'].includes(errorCode(error) ?? '') ? 'PERMISSION' : 'IO_ERROR',
      '无法安全读取或保存文件，请检查权限后重试。',
    );
    publish({ ...base, status, errorCode: failure.code, message: failure.message, repairAvailable });
  };
  const verifyOwnedParents = async (record: OwnedDirectory) => {
    const stat = await safeDirectory(record.directory);
    if (!sameFile(record.directoryStat, stat) || !contained(options.cacheRoot, record.directory)) {
      fail('UNSAFE_PATH', '修复安装器的缓存目录已发生变化。');
    }
  };
  const verifyOwnedParentsSync = (record: OwnedDirectory) => {
    const stat = safeDirectorySync(record.directory);
    if (!sameFile(record.directoryStat, stat) || !contained(options.cacheRoot, record.directory)) {
      fail('UNSAFE_PATH', '修复安装器的缓存目录已发生变化。');
    }
  };
  const cleanup = (record: OwnedDownload) => {
    // Never recurse, enumerate, or delete pre-existing cache/user files.
    try {
      verifyOwnedParentsSync(record);
      const stat = fsSync.lstatSync(record.file);
      if (!sameFile(record.fileStat, stat) || !stat.isFile() || stat.isSymbolicLink()) return;
      fsSync.unlinkSync(record.file);
      fsSync.rmdirSync(record.directory);
    } catch { /* A changed path is left untouched. */ }
  };
  const cleanupDirectory = (record: OwnedDirectory) => {
    try { verifyOwnedParentsSync(record); fsSync.rmdirSync(record.directory); }
    catch { /* Only the empty directory created by this operation may be removed. */ }
  };
  const verifyDownloaded = async (record: OwnedDownload, signal: AbortSignal) => {
    const result = await hashSafeFile(record.file, record.asset.size, signal, () => verifyOwnedParents(record));
    if (!sameFile(record.fileStat, result.stat) || result.sha256 !== record.asset.sha256) {
      fail('INSTALLER_CHANGED', '修复安装器已发生变化，请重新下载。');
    }
    return result.stat;
  };
  const verifyRepairDestination = (inventory: ManifestFile[], expectedRoot?: Stats): Stats => {
    // NSIS writes through existing directory mappings. A signed installer does
    // not make an installation junction or hard link safe to overwrite.
    try {
      const root = path.resolve(options.installRoot);
      if (contained(options.userDataDir, root)) fail('UNSAFE_INSTALL_PATH', '安装目录与用户资料目录重叠。请从官方发布页手动恢复到新的空目录。');
      const rootStat = safeDirectorySync(root);
      if (expectedRoot && !sameFile(expectedRoot, rootStat)) fail('UNSAFE_INSTALL_PATH', '安装目录已发生变化，已阻止覆盖安装。');
      const directories = new Set(['resources', 'locales']);
      for (const file of inventory) {
        const parts = file.path.split('/');
        for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join('/'));
      }
      for (const directory of directories) {
        const target = path.resolve(root, ...directory.split('/'));
        if (!contained(root, target) || contained(options.userDataDir, target)) fail('UNSAFE_INSTALL_PATH', '安装路径不能指向用户资料目录。');
        try { safeDirectorySync(target); }
        catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      }
      // NSIS also replaces its own uninstaller, which is not a version payload
      // file and therefore is deliberately absent from the public inventory.
      for (const relative of [...inventory.map(file => file.path), 'Uninstall Cove.exe']) {
        const target = path.resolve(root, ...relative.split('/'));
        if (!contained(root, target) || contained(options.userDataDir, target)) fail('UNSAFE_INSTALL_PATH', '安装路径不能指向用户资料目录。');
        let stat: Stats;
        try { stat = fsSync.lstatSync(target); }
        catch (error) { if (errorCode(error) === 'ENOENT') continue; throw error; }
        regularFile(stat);
      }
      if (!sameFile(rootStat, safeDirectorySync(root))) fail('UNSAFE_INSTALL_PATH', '安装目录已发生变化，已阻止覆盖安装。');
      return rootStat;
    } catch (error) {
      if (error instanceof IntegrityError && ['UNSAFE_PATH', 'UNSAFE_INSTALL_PATH'].includes(error.code)) {
        fail('UNSAFE_INSTALL_PATH', '安装目录包含链接或不安全的文件映射，已阻止覆盖安装。请从官方发布页手动恢复到新的空目录。');
      }
      throw error;
    }
  };
  const verifyLaunchPath = (record: OwnedDownload, verified: Stats) => {
    verifyOwnedParentsSync(record);
    regularFile(fsSync.lstatSync(record.file));
    let marked = false;
    try { marked = (options.verifyDownloadedFile ?? verifyInternetDownload)(record.file); }
    catch { /* Treat all Attachment Manager failures identically. */ }
    if (!marked) fail('MOTW_FAILED', 'Windows 下载安全标记已失效。请在浏览器中前往官方发布页重新下载安装器。');
    // The test callback is also checked before the final, non-reentrant guard.
    verifyRepairDestination(record.inventory, record.installRootStat);
    verifyOwnedParentsSync(record);
    const named = fsSync.lstatSync(record.file);
    regularFile(named);
    if (!unchangedFile(verified, named) || folded(fsSync.realpathSync(record.file)) !== folded(path.resolve(record.file))) {
      fail('INSTALLER_CHANGED', '修复安装器已发生变化，请重新下载。');
    }
  };

  async function checkNow(): Promise<InstallationIntegrityState> {
    const op = begin('checking');
    if (!op) return getState();
    let repairAvailable = false;
    try {
      const release = await officialRelease(fetchImpl, options.version, op.controller.signal);
      repairAvailable = !!release.installer;
      if (!release.manifest) {
        if (current(op)) publish({ ...base, status: 'unavailable', repairAvailable: false,
          errorCode: 'MANIFEST_UNAVAILABLE', message: '此版本未发布官方完整性清单，无法核验或安全启动覆盖安装。请前往官方发布页手动恢复。' });
        return getState();
      }
      const bytes = await receive(fetchImpl, release.manifest.url, op.controller.signal, MAX_JSON_BYTES, release.manifest.size);
      if (createHash('sha256').update(bytes).digest('hex') !== release.manifest.sha256) fail('MANIFEST_DIGEST_MISMATCH', '官方完整性清单校验失败，请稍后重试。');
      const files = parseManifest(bytes, options.version);
      const root = path.resolve(options.installRoot);
      if (contained(options.userDataDir, root)) fail('UNSAFE_PATH', '安装目录与用户数据目录重叠，无法安全核验。');
      const rootStat = await safeDirectory(root);
      const issues: InstallationIntegrityIssue[] = [];
      let issueCount = 0;
      let damaged = false;
      let unreadable = false;
      for (let index = 0; index < files.length; index++) {
        abortIfNeeded(op.controller.signal);
        const file = files[index];
        const target = path.resolve(root, ...file.path.split('/'));
        let kind: InstallationIntegrityIssue['kind'] | undefined;
        try {
          if (!contained(root, target) || contained(options.userDataDir, target)) fail('UNSAFE_PATH', '清单路径不能指向用户数据目录。');
          const verifyParents = async () => {
            const now = await safeDirectory(root);
            if (!sameFile(rootStat, now)) fail('UNSAFE_PATH', '安装目录在核验期间发生变化。');
            await safeDirectory(path.dirname(target));
          };
          const result = await hashSafeFile(target, file.size, op.controller.signal, verifyParents);
          if (result.sha256 !== file.sha256) kind = 'modified';
        } catch (error) {
          if (error instanceof IntegrityError && error.code === 'CANCELLED') throw error;
          kind = error instanceof IntegrityError && error.code === 'UNSAFE_PATH' ? 'unsafe'
            : error instanceof IntegrityError && error.code === 'FILE_MODIFIED' ? 'modified'
              : errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
        }
        if (kind) {
          issueCount++;
          if (issues.length < MAX_ISSUES) issues.push({ path: file.path, kind });
          if (kind === 'unreadable') unreadable = true; else damaged = true;
          if (kind === 'unsafe') repairAvailable = false;
        }
        if (current(op)) publish({ ...base, status: 'checking', repairAvailable, checkedFiles: index + 1, totalFiles: files.length, issueCount, issues });
      }
      if (current(op)) publish({ ...base, status: damaged ? 'damaged' : unreadable ? 'unavailable' : 'healthy', repairAvailable,
        checkedAt: Date.now(), checkedFiles: files.length, totalFiles: files.length, issueCount, issues,
        ...(unreadable ? { errorCode: 'UNREADABLE_FILES' } : {}),
        message: damaged ? repairAvailable
          ? '部分安装文件缺失或被修改。可使用同版本官方安装器覆盖安装。'
          : '安装文件存在异常或不安全的映射，无法自动覆盖安装。请前往官方发布页手动恢复。'
          : unreadable ? '部分安装文件无法读取，尚不能判断安装是否完整。请检查文件权限后重试。'
            : '安装文件与当前版本的官方完整性清单一致。' });
    } catch (error) { report(op, error, 'unavailable', repairAvailable && !(error instanceof IntegrityError && error.code === 'UNSAFE_PATH')); }
    finally { finish(op); }
    return getState();
  }

  async function downloadRepair(): Promise<InstallationIntegrityState> {
    const op = begin('downloading');
    if (!op) return getState();
    let record: OwnedDownload | undefined;
    let ownedDirectory: OwnedDirectory | undefined;
    let handle: FileHandle | undefined;
    let retained = false;
    let repairAvailable = false;
    try {
      const release = await officialRelease(fetchImpl, options.version, op.controller.signal);
      if (!release.manifest) fail('REPAIR_PREFLIGHT_UNAVAILABLE', '此版本缺少官方完整性清单，无法安全检查覆盖安装路径。请前往官方发布页手动恢复。');
      if (!release.installer) fail('INSTALLER_UNAVAILABLE', '当前版本没有可验证的官方安装器，请前往官方发布页。');
      const manifestBytes = await receive(fetchImpl, release.manifest.url, op.controller.signal, MAX_JSON_BYTES, release.manifest.size);
      if (createHash('sha256').update(manifestBytes).digest('hex') !== release.manifest.sha256) fail('MANIFEST_DIGEST_MISMATCH', '官方完整性清单校验失败，请稍后重试。');
      const inventory = parseManifest(manifestBytes, options.version);
      abortIfNeeded(op.controller.signal);
      const installRootStat = verifyRepairDestination(inventory);
      repairAvailable = true;
      abortIfNeeded(op.controller.signal);
      const cacheRoot = path.resolve(options.cacheRoot);
      if (contained(options.installRoot, cacheRoot) || contained(options.userDataDir, cacheRoot)) {
        fail('UNSAFE_PATH', '修复缓存必须位于安装目录和用户资料目录之外。');
      }
      await safeDirectory(path.dirname(cacheRoot));
      abortIfNeeded(op.controller.signal);
      try { await fs.mkdir(cacheRoot, { mode: 0o700 }); }
      catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
      abortIfNeeded(op.controller.signal);
      await safeDirectory(cacheRoot);
      abortIfNeeded(op.controller.signal);
      const directory = await fs.mkdtemp(path.join(path.resolve(options.cacheRoot), 'repair-'));
      // Record ownership synchronously before the next cancellable await.
      ownedDirectory = { directory, directoryStat: fsSync.lstatSync(directory) };
      abortIfNeeded(op.controller.signal);
      await verifyOwnedParents(ownedDirectory);
      abortIfNeeded(op.controller.signal);
      const file = path.join(directory, release.installer.name);
      handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      record = { ...ownedDirectory, file, fileStat: fsSync.fstatSync(handle.fd), asset: release.installer, inventory, installRootStat };
      abortIfNeeded(op.controller.signal);
      regularFile(record.fileStat);
      const hash = createHash('sha256');
      let lastProgress = 0;
      await receive(fetchImpl, release.installer.url, op.controller.signal, MAX_INSTALLER_BYTES, release.installer.size, async (chunk, transferred) => {
        abortIfNeeded(op.controller.signal);
        hash.update(chunk);
        let written = 0;
        while (written < chunk.byteLength) {
          abortIfNeeded(op.controller.signal);
          const result = await handle!.write(chunk, written, chunk.byteLength - written);
          if (!result.bytesWritten) fail('IO_ERROR', '无法保存修复安装器。');
          written += result.bytesWritten;
        }
        if (current(op) && (Date.now() - lastProgress >= 100 || transferred === release.installer!.size)) {
          lastProgress = Date.now();
          publish({ ...base, status: 'downloading', repairAvailable: true,
            progress: { transferred, total: release.installer!.size, percent: Math.floor(transferred * 100 / release.installer!.size) } });
        }
      });
      if (hash.digest('hex') !== release.installer.sha256) fail('INSTALLER_DIGEST_MISMATCH', '官方安装器 SHA-256 校验失败，请重新下载。');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await verifyDownloaded(record, op.controller.signal);
      abortIfNeeded(op.controller.signal);
      try { await (options.markDownloadedFile ?? markInternetDownload)(record.file); }
      catch { fail('MOTW_FAILED', '无法保留 Windows 下载安全标记。请在浏览器中打开官方发布页下载安装器。'); }
      abortIfNeeded(op.controller.signal);
      await verifyDownloaded(record, op.controller.signal);
      abortIfNeeded(op.controller.signal);
      if (current(op)) {
        const previous = downloaded;
        downloaded = record;
        retained = true;
        publish({ ...base, status: 'downloaded', repairAvailable: true,
          message: '同版本官方安装器已下载并验证。覆盖安装前仍需确认，完成后请重启并再次检查。' });
        if (previous) cleanup(previous);
      }
    } catch (error) { report(op, error, 'error', repairAvailable); }
    finally {
      await handle?.close().catch(() => {});
      if (record && !retained) cleanup(record);
      else if (ownedDirectory && !retained) cleanupDirectory(ownedDirectory);
      finish(op);
    }
    return getState();
  }

  async function launchRepair(): Promise<boolean> {
    if (!downloaded) return false;
    const record = downloaded;
    const op = begin('confirming');
    if (!op) return false;
    try {
      await verifyDownloaded(record, op.controller.signal);
      if (!current(op)) return false;
      verifyRepairDestination(record.inventory, record.installRootStat);
      // The native dialog cannot be aborted. Keep the physical maintenance lock
      // until its original promise settles, even after cancellation invalidates it.
      op.confirmationPending = true;
      let confirmed: boolean;
      try { confirmed = await options.confirmInstall(); }
      finally { op.confirmationPending = false; }
      if (!current(op)) return false;
      if (!confirmed) {
        publish({ ...base, status: 'downloaded', repairAvailable: true, message: '已取消启动，验证过的安装器仍已保留。' });
        return false;
      }
      if (options.isExternalBusy()) fail('BUSY', '更新任务正在进行，请完成后重试。');
      const verified = await verifyDownloaded(record, op.controller.signal);
      if (!current(op)) return false;
      if (options.isExternalBusy()) fail('BUSY', '更新任务正在进行，请完成后重试。');
      publish({ ...base, status: 'launching', repairAvailable: true, message: '正在打开官方安装器。安装完成后请重启并再次检查。' });
      if (!current(op)) return false;
      if (options.isExternalBusy()) fail('BUSY', '更新任务正在进行，请完成后重试。');
      // publishState/isExternalBusy are application callbacks. Detect changes
      // they make before committing to the pathname-based OS launch.
      verifyLaunchPath(record, verified);
      op.committed = true;
      const opened = await options.openInstaller(record.file);
      if (!current(op)) return false;
      if (!opened) fail('LAUNCH_FAILED', '无法打开官方安装器，请在浏览器中前往官方发布页。');
      // An accepted OS request cannot be undone if app.quit is delayed or denied.
      handedOff = true;
      try { options.quit(); }
      catch {
        publish({ ...base, status: 'launching', repairAvailable: true, message: '官方安装器已打开。请关闭应用并完成安装，随后重启再次检查。' });
      }
      return true;
    } catch (error) { report(op, error, 'error', !(error instanceof IntegrityError && error.code === 'UNSAFE_INSTALL_PATH')); return false; }
    finally {
      if (!disposed && active === op && op.controller.signal.aborted) {
        publish({ ...op.previous, message: '操作已取消。' });
      }
      finish(op);
    }
  }

  async function cancel(): Promise<InstallationIntegrityState> {
    if (active) {
      const op = active;
      // Once the OS launch request is committed, it cannot safely be undone.
      if (op.committed) return getState();
      if (op.confirmationPending) {
        op.controller.abort();
        publish({ ...state, message: '操作已取消，等待确认窗口关闭。' });
        return getState();
      }
      active = undefined;
      op.controller.abort();
      publish({ ...op.previous, message: '操作已取消。' });
    }
    return getState();
  }
  function dispose(): void {
    disposed = true;
    const op = active;
    active = undefined;
    handedOff = false;
    op?.controller.abort();
  }
  return { getState, checkNow, downloadRepair, cancel, launchRepair, isBusy: () => !!active || handedOff, dispose };
}
