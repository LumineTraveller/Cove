import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import net from 'net';
import os from 'os';

export function cacheError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Reject redirects and non-regular files before reading or replacing a baseline. */
export function checkCacheDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      path.relative(resolved, fs.realpathSync(resolved)) !== '') {
    throw cacheError('COVE_CACHE_UNSAFE', 'Updater cache directory is redirected');
  }
}

export function regularCacheFile(file: string): fs.Stats {
  checkCacheDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw cacheError('COVE_CACHE_UNSAFE', `Updater cache file is not an independent regular file: ${path.basename(file)}`);
  }
  return stat;
}

export function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function hashStableFile(file: string, checkCancelled?: () => void): Promise<{ sha512: string; stat: fs.Stats }> {
  checkCancelled?.();
  const before = regularCacheFile(file);
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) { checkCancelled?.(); hash.update(chunk); }
  checkCancelled?.();
  const after = regularCacheFile(file);
  if (!sameFile(before, after)) throw cacheError('COVE_BASELINE_CHANGED', 'Installer baseline changed during verification');
  return { sha512: hash.digest('base64'), stat: after };
}

/** Atomic replacement, bounded to one checked file in the updater cache. */
export function writeCacheFile(file: string, contents: Buffer | string): void {
  checkCacheDirectory(path.dirname(file));
  try { regularCacheFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Already renamed or creation failed. */ }
  }
}

/** Coordinates Cove updater processes; NSIS/external programs do not honor it. */
export async function acquireUpdateCacheLock(cacheDir: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (signal?.aborted) throw cacheError('COVE_UPDATE_CANCELLED', 'Updater cache lock acquisition cancelled');
  fs.mkdirSync(cacheDir, { recursive: true });
  checkCacheDirectory(cacheDir);
  const actualPath = fs.realpathSync(cacheDir);
  const canonical = process.platform === 'win32' ? actualPath.toLowerCase() : actualPath;
  const key = createHash('sha256').update(canonical).digest('hex');
  // Windows named pipes and Linux abstract sockets disappear when their owning
  // process exits, including crashes. No PID files, stale-file guesses or unlink
  // races are needed. Other platforms fail closed on a leftover socket path.
  const name = process.platform === 'win32' ? `\\\\.\\pipe\\cove-update-${key}`
    : process.platform === 'linux' ? `\0cove-update-${key}`
    : path.join(os.tmpdir(), `cove-update-${key.slice(0, 32)}.sock`);
  const server = net.createServer(socket => socket.destroy());
  server.unref();
  server.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const close = () => { try { server.close(); } catch { /* No listening handle. */ } };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
      close();
      reject(error);
    };
    const onCancel = () => fail(cacheError('COVE_UPDATE_CANCELLED', 'Updater cache lock acquisition cancelled'));
    const timer = setTimeout(() => fail(cacheError('COVE_CACHE_BUSY', 'Updater cache lock acquisition timed out')), 5_000);
    const onError = (error: NodeJS.ErrnoException) => {
      fail(cacheError(error.code === 'EADDRINUSE' ? 'COVE_CACHE_BUSY' : 'COVE_CACHE_LOCK_FAILED',
        'Updater cache lock could not be acquired'));
    };
    server.once('error', onError);
    signal?.addEventListener('abort', onCancel, { once: true });
    try { server.listen(name, () => {
      if (settled) { close(); return; }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
      server.off('error', onError);
      // A listening IPC lock does not accept commands or payloads. Keep an error
      // listener so an unexpected server error cannot crash the application.
      resolve();
    }); } catch (error) { onError(error as NodeJS.ErrnoException); }
  });
  let closing: Promise<void> | undefined;
  return () => closing ??= new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 5_000);
    try { server.close(() => { clearTimeout(timer); resolve(); }); }
    catch { clearTimeout(timer); resolve(); }
  });
}
