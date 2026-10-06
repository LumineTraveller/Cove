import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAvatarStorage, mapAvatarUrls, avatarOrigin } from '../src/features/profiles/avatarStorage';

test('avatar files retain GIF bytes and crop, deduplicate and reject unsafe references', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-avatar-'));
  try {
    const store = createAvatarStorage(directory);
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const inline = `data:image/gif;base64,${bytes.toString('base64')}#cove-crop=0.5,0.6,1.2`;
    const reference = store.save(inline)!;
    assert.match(reference, /^\/avatars\/[a-f0-9]{64}\.gif#cove-crop=0.5,0.6,1.2$/);
    assert.deepEqual(fs.readFileSync(path.join(directory, reference.split('#')[0])), bytes);
    assert.equal(store.save(inline), reference);
    assert.equal(fs.readdirSync(store.directory).length, 1);
    const external = new URL(reference, 'https://example.com');
    external.searchParams.set('access_token', 'ignored');
    assert.equal(store.save(external.href), reference);
    for (const invalid of ['/avatars/../../cove.db', '/avatars/missing.gif', 'data:image/svg+xml;base64,AAAA', 'data:image/gif;base64,AAAA#script', 'data:image/gif;base64,%%%'])
      assert.equal(store.save(invalid), null);
    const own = mapAvatarUrls({ members: [{ avatarUrl: reference }] }, 'https://cove.luxe', 'recipient-token');
    assert.equal(new URL(own.members[0].avatarUrl).searchParams.get('access_token'), 'recipient-token');
    assert.equal(new URL(own.members[0].avatarUrl).hash, '#cove-crop=0.5,0.6,1.2');
    assert.equal(reference.includes('token'), false);
    const clear = mapAvatarUrls({ avatarUrl: reference }, 'http://localhost:3001');
    assert.ok(clear.avatarUrl.startsWith('http://localhost:3001/avatars/'));
    assert.equal(clear.avatarUrl.includes('access_token'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('avatar origins only trust forwarded protocol when opted in', () => {
  const original = process.env.COVE_TRUST_PROXY;
  const publicBase = process.env.COVE_PUBLIC_BASE_URL;
  try {
    delete process.env.COVE_PUBLIC_BASE_URL;
    delete process.env.COVE_TRUST_PROXY;
    assert.equal(avatarOrigin({ host: '[invalid' }), 'http://localhost');
    assert.equal(avatarOrigin({ host: 'user:password@example.com' }), 'http://localhost');
    assert.equal(avatarOrigin({ host: 'localhost:3001', 'x-forwarded-proto': 'https' }), 'http://localhost:3001');
    process.env.COVE_TRUST_PROXY = 'true';
    assert.equal(avatarOrigin({ host: 'cove.luxe', 'x-forwarded-proto': 'https' }), 'https://cove.luxe');
    process.env.COVE_PUBLIC_BASE_URL = 'https://cove.luxe';
    assert.equal(avatarOrigin({ host: '127.0.0.1:3001' }), 'https://cove.luxe');
  } finally {
    if (original === undefined) delete process.env.COVE_TRUST_PROXY; else process.env.COVE_TRUST_PROXY = original;
    if (publicBase === undefined) delete process.env.COVE_PUBLIC_BASE_URL; else process.env.COVE_PUBLIC_BASE_URL = publicBase;
  }
});
