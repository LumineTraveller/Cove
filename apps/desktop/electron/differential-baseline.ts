import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import {
  cacheError, hashStableFile, regularCacheFile, sameFile, writeCacheFile,
} from './update-cache-safety';

export interface BaselineIdentity {
  schema: 1;
  version: string;
  sha512: string;
  size: number;
  blockmapSha512?: string;
}

const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const CURRENT = 'cove-baseline.json';
const NEXT = 'cove-next-baseline.json';
const NEXT_MAP = 'cove-next.blockmap';

function digest(data: Buffer): string {
  return createHash('sha512').update(data).digest('base64');
}

function readSmall(file: string, limit: number): Buffer | null {
  try {
    if (regularCacheFile(file).size > limit) throw cacheError('COVE_BASELINE_INVALID', 'Baseline metadata exceeds its size limit');
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function identity(value: unknown, version: string): BaselineIdentity | null {
  const record = value as BaselineIdentity | null;
  return record?.schema === 1 && record.version === version && SHA512.test(record.sha512) &&
    Number.isSafeInteger(record.size) && record.size > 0 &&
    (record.blockmapSha512 == null || SHA512.test(record.blockmapSha512)) ? record : null;
}

function readIdentity(cache: string, name: string, version: string): BaselineIdentity | null {
  const data = readSmall(path.join(cache, name), 16_384);
  if (!data) return null;
  try { return identity(JSON.parse(data.toString('utf8')), version); }
  catch { throw cacheError('COVE_BASELINE_INVALID', 'Baseline identity record is unreadable'); }
}

/** Validate bounded compressed metadata before handing it to the native planner. */
export function validateBlockmap(data: Buffer, installerSize: number): void {
  if (data.length > 8 * 1024 * 1024) throw cacheError('COVE_BLOCKMAP_INVALID', 'Blockmap exceeds its size limit');
  const map = JSON.parse(gunzipSync(data, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
  let end = 0;
  if (!['1', '2'].includes(map.version) || !Array.isArray(map.files) || !map.files.length) {
    throw cacheError('COVE_BLOCKMAP_INVALID', 'Blockmap format is invalid');
  }
  for (const file of map.files) {
    if (!Number.isSafeInteger(file.offset) || file.offset < end || !Array.isArray(file.sizes) ||
        !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length ||
        file.sizes.some((size: unknown) => !Number.isSafeInteger(size) || (size as number) <= 0) ||
        file.checksums.some((sum: unknown) => typeof sum !== 'string' || !sum)) {
      throw cacheError('COVE_BLOCKMAP_INVALID', 'Blockmap chunks are invalid');
    }
    end = file.offset + file.sizes.reduce((sum: number, size: number) => sum + size, 0);
    if (!Number.isSafeInteger(end) || end > installerSize) throw cacheError('COVE_BLOCKMAP_INVALID', 'Blockmap exceeds the installer');
  }
  if (end !== installerSize) throw cacheError('COVE_BLOCKMAP_INVALID', 'Blockmap size does not match the installer');
}

export async function prepareDifferentialBaseline(options: {
  cacheDir: string;
  installedVersion: string;
  installerFileName: string;
  recoverIdentity: () => Promise<BaselineIdentity>;
  downloadOldBlockmap: () => Promise<Buffer>;
  checkCancelled?: () => void;
}): Promise<void> {
  const { cacheDir, installedVersion, installerFileName } = options;
  if (path.basename(installerFileName) !== installerFileName) throw cacheError('COVE_CACHE_UNSAFE', 'Invalid baseline filename');
  const installer = path.join(cacheDir, installerFileName);
  const initial = regularCacheFile(installer);
  if (initial.size === 0) throw cacheError('COVE_BASELINE_INVALID', 'Installer baseline is empty');
  let record = readIdentity(cacheDir, CURRENT, installedVersion);
  let mapName = 'current.blockmap';
  if (!record) {
    record = readIdentity(cacheDir, NEXT, installedVersion);
    if (record) mapName = NEXT_MAP;
  }
  // Old versions leave validated pending metadata after NSIS copies the EXE.
  // It is useful only when the exact installed version's filename matches.
  if (!record) {
    const pending = readSmall(path.join(cacheDir, 'pending', 'update-info.json'), 16_384);
    if (pending) {
      try {
        const info = JSON.parse(pending.toString('utf8'));
        if (info.fileName === `Cove-Setup-${installedVersion}.exe` && SHA512.test(info.sha512)) {
          record = { schema: 1, version: installedVersion, sha512: info.sha512, size: initial.size };
        }
      } catch { /* Recover from the official installed-version manifest instead. */ }
    }
  }
  if (!record) record = identity(await options.recoverIdentity(), installedVersion);
  if (!record) throw cacheError('COVE_BASELINE_UNVERIFIED', 'The installed version baseline identity could not be verified');
  if (initial.size !== record.size) throw cacheError('COVE_BASELINE_MISMATCH', 'Installer baseline size does not match the installed release');
  options.checkCancelled?.();
  const verified = await hashStableFile(installer, options.checkCancelled);
  options.checkCancelled?.();
  if (verified.sha512 !== record.sha512) throw cacheError('COVE_BASELINE_MISMATCH', 'Installer baseline SHA512 does not match the installed release');
  let blockmap: Buffer | null = null;
  if (record.blockmapSha512) {
    blockmap = readSmall(path.join(cacheDir, mapName), 8 * 1024 * 1024);
    if (blockmap && digest(blockmap) !== record.blockmapSha512) blockmap = null;
  }
  // Never trust a legacy root map by existence/size: electron-updater 6.8.9
  // may have copied the NEXT version's blockmap here before installation.
  if (!blockmap) blockmap = await options.downloadOldBlockmap();
  validateBlockmap(blockmap, verified.stat.size);
  options.checkCancelled?.();
  if (!sameFile(verified.stat, regularCacheFile(installer))) {
    throw cacheError('COVE_BASELINE_CHANGED', 'Installer baseline changed after verification');
  }
  writeCacheFile(path.join(cacheDir, 'current.blockmap'), blockmap);
  writeCacheFile(path.join(cacheDir, CURRENT), JSON.stringify({ ...record, blockmapSha512: digest(blockmap) }));
}

/** Called only after native SHA512/signature validation; never promotes an uninstalled EXE. */
export function stageNextBaseline(cacheDir: string, record: BaselineIdentity): { ignoredInvalidMap: boolean } {
  if (!identity(record, record.version)) throw cacheError('COVE_BASELINE_INVALID', 'Downloaded baseline identity is invalid');
  const pendingMap = path.join(cacheDir, 'pending', 'current.blockmap');
  let data: Buffer | null = null;
  let mapExists = false;
  let ignoredInvalidMap = false;
  try {
    const stat = regularCacheFile(pendingMap);
    mapExists = true;
    if (stat.size <= 8 * 1024 * 1024) data = fs.readFileSync(pendingMap);
    else ignoredInvalidMap = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let next = record;
  if (data) {
    try { validateBlockmap(data, record.size); }
    catch { ignoredInvalidMap = true; }
    if (!ignoredInvalidMap) {
      writeCacheFile(path.join(cacheDir, NEXT_MAP), data);
      next = { ...record, blockmapSha512: digest(data) };
    }
  }
  if (mapExists) {
    // The upstream done() copies this file to the root after dispatching its
    // event. Move it out of that path first so the installed pair stays intact.
    fs.unlinkSync(pendingMap);
  }
  writeCacheFile(path.join(cacheDir, NEXT), JSON.stringify(next));
  return { ignoredInvalidMap };
}
