import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { LoggerLike, UpdateInfoLike, UpdateSourceCandidate } from './updater-core';

const MARKER = 'pending/cove-gitee-cleanup.json';
const UPDATE_INFO = 'pending/update-info.json';
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;

interface CleanupRecord {
  schema: 1;
  source: 'gitee';
  version: string;
  fileName: string;
  sha512: string;
}

/** Only this app's Windows NSIS cache is eligible, never Downloads or app data. */
export function createGiteeInstallerCache(options: {
  localAppData: string;
  installedVersion: string;
  logger: LoggerLike;
  delay?: (ms: number) => Promise<void>;
}) {
  if (!path.isAbsolute(options.localAppData)) throw new Error('LOCALAPPDATA must be an absolute path');
  const cacheDir = path.join(options.localAppData, 'cove-client-updater');
  const pendingDir = path.join(cacheDir, 'pending');
  const { logger } = options;

  function checkDirectory(directory: string): boolean {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          path.relative(path.resolve(directory), fs.realpathSync(directory)) !== '') {
        throw new Error(`拒绝访问重定向的更新缓存目录：${directory}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  function cacheExists(): boolean {
    return checkDirectory(cacheDir) && checkDirectory(pendingDir);
  }

  function safeFile(relative: string): { file: string; exists: boolean } {
    const file = path.resolve(cacheDir, relative);
    if (![cacheDir, pendingDir].includes(path.dirname(file)) || !cacheExists()) {
      throw new Error('安装包清理目标不在预期缓存目录中');
    }
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`拒绝访问非普通缓存文件：${file}`);
      }
      return { file, exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, exists: false };
      throw error;
    }
  }

  function readJson(relative: string): any {
    const target = safeFile(relative);
    if (!target.exists) return null;
    if (fs.statSync(target.file).size > 16_384) throw new Error('更新缓存元数据过大');
    return JSON.parse(fs.readFileSync(target.file, 'utf8'));
  }

  function remove(relative: string): void {
    const target = safeFile(relative);
    if (target.exists) {
      // Exact individual files only; never recursively remove a cache directory.
      fs.unlinkSync(target.file);
      logger.info(`[updater] 已清理安装包缓存 ${relative}`);
    }
  }

  async function hash(relative: string): Promise<string | null> {
    const target = safeFile(relative);
    if (!target.exists) return null;
    const digest = createHash('sha512');
    for await (const chunk of fs.createReadStream(target.file)) digest.update(chunk);
    return digest.digest('base64');
  }

  function samePackage(info: any, record: CleanupRecord): boolean {
    return info?.fileName === record.fileName && info?.sha512 === record.sha512;
  }

  function remember(info: UpdateInfoLike, source?: UpdateSourceCandidate['id']): void {
    if (source !== 'gitee' || !VERSION.test(info.version) || !info.downloadedFile) return;
    const fileName = `Cove-Setup-${info.version}.exe`;
    if (path.resolve(info.downloadedFile) !== path.join(pendingDir, fileName) || !cacheExists()) return;
    const downloaded = safeFile(`pending/${fileName}`);
    const metadata = readJson(UPDATE_INFO);
    if (!downloaded.exists || metadata?.fileName !== fileName || !SHA512.test(metadata?.sha512 ?? '')) return;
    const record: CleanupRecord = { schema: 1, source: 'gitee', version: info.version, fileName, sha512: metadata.sha512 };
    fs.writeFileSync(safeFile(MARKER).file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    logger.info(`[updater] 已记录 Gitee 安装包清理任务，等待 ${info.version} 安装并启动`);
  }

  async function cleanupOnce(): Promise<void> {
    if (!cacheExists()) return;
    const record = readJson(MARKER) as CleanupRecord | null;
    // Restarting the OLD app after a failed/cancelled install must keep the EXE.
    if (!record || record.schema !== 1 || record.source !== 'gitee' ||
        !VERSION.test(record.version) || record.version !== options.installedVersion ||
        record.fileName !== `Cove-Setup-${record.version}.exe` || !SHA512.test(record.sha512)) return;
    const metadata = readJson(UPDATE_INFO);
    if (metadata && !samePackage(metadata, record)) return;
    const pendingInstaller = `pending/${record.fileName}`;
    const pendingHash = await hash(pendingInstaller);
    if (pendingHash !== null && pendingHash !== record.sha512) throw new Error('待清理安装包校验值已改变，保留文件');
    const installedCacheHash = await hash('installer.exe');
    // Check again after asynchronous hashing. Never clear a newer pending update.
    const latestRecord = readJson(MARKER);
    const latestMetadata = readJson(UPDATE_INFO);
    if (JSON.stringify(latestRecord) !== JSON.stringify(record) ||
        (latestMetadata && !samePackage(latestMetadata, record))) return;
    if (installedCacheHash === record.sha512) {
      // NSIS keeps another copy for the next differential update. Gitee no longer
      // needs that copy. A different (e.g. GitHub) baseline is left untouched.
      remove('installer.exe');
      remove('current.blockmap');
    }
    remove(pendingInstaller);
    remove('pending/current.blockmap');
    remove(UPDATE_INFO);
    remove(MARKER);
    logger.info(`[updater] ${record.version} 已启动，本次 Gitee 安装包清理完成`);
  }

  async function cleanupInstalledUpdate(): Promise<void> {
    // The installer may still hold its own EXE briefly after starting Cove.
    // Keep the marker if locked so another startup can safely retry as well.
    const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await cleanupOnce(); return; }
      catch (error) {
        logger.warn('[updater] 安装包缓存暂未清理，保留任务以便重试', error);
        if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt === 2) return;
        await delay(1500);
      }
    }
  }

  return { remember, cleanupInstalledUpdate };
}
