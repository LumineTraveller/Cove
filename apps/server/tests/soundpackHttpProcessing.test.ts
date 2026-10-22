import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerSoundpacksRoutes } from '../src/features/soundpacks/httpRoutes';
import { soundpackCancelled, SoundpackProcessingError } from '../src/features/soundpacks/soundpackWorkQueue';

function fixture(t: import('node:test').TestContext, normalize: (source: string, target: string, options: { signal?: AbortSignal }) => Promise<unknown>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-soundpack-http-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  let post!: (req: any, res: any) => Promise<void>;
  const server = new AbortController();
  let inserted = 0;
  const actor = { roomId: 'room', socketId: 'socket', username: 'fixture', clientId: 'account:fixture' };
  const req = Object.assign(new EventEmitter(), {
    body: { roomId: 'room', name: 'fixture', mimeType: 'audio/wav', data: Buffer.from('synthetic').toString('base64') },
    aborted: false,
  });
  const headers = new Map<string, unknown>();
  let status = 200; let body: any;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableFinished: false,
    setHeader: (key: string, value: unknown) => headers.set(key, value),
    vary: () => {},
    status: (value: number) => { status = value; return res; },
    json: (value: unknown) => { body = value; res.writableFinished = true; return res; },
  });
  registerSoundpacksRoutes({
    app: { get: () => {}, post: (_route: string, handler: typeof post) => { post = handler; } },
    access: { httpRoomActor: () => actor, revalidateActor: () => actor },
    SOUNDS_DIR: directory, processingSignal: server.signal, normalize,
    stmtGetSoundpacks: {}, stmtGetSoundpack: {}, stmtGetNextSoundpackOrder: { get: () => ({ sortOrder: 1 }) },
    stmtInsertSoundpack: { run: () => inserted++ }, broadcastSoundpackAdded: () => {},
    toPublicSoundpack: (pack: unknown) => pack,
  } as never);
  return { req, res, server, directory, run: () => post(req, res), inserted: () => inserted, status: () => status, body: () => body, headers };
}

for (const reason of ['response-close', 'request-aborted', 'server-stop'] as const) {
  test(`${reason} cancels processing, waits for worker release and never commits partial files`, async t => {
    let release!: () => void;
    let signal!: AbortSignal;
    const f = fixture(t, async (_source, target, options) => {
      signal = options.signal!;
      fs.writeFileSync(target, 'partial');
      await new Promise<void>(resolve => { release = resolve; });
      if (signal.aborted) throw soundpackCancelled();
    });
    const pending = f.run();
    assert.ok(signal);
    assert.equal(fs.readdirSync(f.directory).length, 2);
    if (reason === 'response-close') f.res.emit('close');
    else if (reason === 'request-aborted') { f.req.aborted = true; f.req.emit('aborted'); }
    else f.server.abort();
    assert.equal(signal.aborted, true);
    assert.equal(fs.readdirSync(f.directory).length, 2, 'do not unlink while the worker may still be writing');
    release(); await pending;
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal(f.inserted(), 0);
    assert.equal(f.req.listenerCount('aborted'), 0);
    assert.equal(f.res.listenerCount('close'), 0);
  });
}

for (const code of ['SOUNDPACK_QUEUE_FULL', 'SOUNDPACK_QUEUE_TIMEOUT'] as const) {
  test(`${code} returns retryable capacity feedback and removes uncommitted source`, async t => {
    const f = fixture(t, async () => { throw new SoundpackProcessingError(code, '语音包处理繁忙，请稍后重试'); });
    await f.run();
    assert.equal(f.status(), 503);
    assert.equal(f.body().code, code);
    assert.equal(f.headers.get('Retry-After'), '2');
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal(f.inserted(), 0);
  });
}

test('success keeps original/playback only and removes request cancellation listeners', async t => {
  const f = fixture(t, async (_source, target) => { fs.writeFileSync(target, 'completed synthetic'); });
  await f.run();
  assert.equal(f.status(), 200);
  assert.equal(f.inserted(), 1);
  assert.equal(fs.readdirSync(f.directory).length, 2);
  assert.ok(fs.readdirSync(f.directory).every(name => !name.includes('.normalizing.')));
  assert.equal(f.req.listenerCount('aborted'), 0);
  assert.equal(f.res.listenerCount('close'), 0);
  f.res.emit('close');
  assert.equal(f.inserted(), 1);
});
