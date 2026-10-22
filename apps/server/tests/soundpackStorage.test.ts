import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Module from 'node:module';

// Runtime Node provides SQLite; this repository's Node typings predate it.
interface FixtureDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...values: any[]): any[]; get(...values: any[]): any; run(...values: any[]): { changes: number | bigint } };
  close(): void;
}
const { DatabaseSync }: { DatabaseSync: new (filename: string) => FixtureDatabase } = require('node:sqlite');

// Exercise the production migrations and repository SQL without a native addon.
class TestDatabase {
  static readonly open = new Set<TestDatabase>();
  private readonly db: FixtureDatabase;
  constructor(filename: string) { this.db = new DatabaseSync(filename); TestDatabase.open.add(this); }
  exec(sql: string) { return this.db.exec(sql); }
  pragma(sql: string) { return this.db.exec(`PRAGMA ${sql}`); }
  prepare(sql: string) { return this.db.prepare(sql); }
  transaction<T extends (...args: any[]) => any>(fn: T) {
    return (...args: Parameters<T>) => {
      this.db.exec('BEGIN');
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
  }
  close() {
    if (!TestDatabase.open.delete(this)) return;
    this.db.close();
  }
}

test('soundpack storage preserves room ownership and quarantines historical global rows', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cove-soundpack-storage-'));
  const keys = ['COVE_DATA_DIR', 'COVE_DOWNLOAD_DIR'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalLoad = (Module as any)._load;
  let database: any;
  (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === 'better-sqlite3') return TestDatabase;
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_DOWNLOAD_DIR = path.join(dataDir, 'downloads');
  try {
    const legacy = new DatabaseSync(path.join(dataDir, 'cove.db'));
    legacy.exec('CREATE TABLE soundpacks (id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, uploader TEXT NOT NULL, createdAt INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO soundpacks VALUES (?, ?, ?, ?, ?)')
      .run('old-global', 'Old global fixture', 'old-global.wav', 'Fixture', 1);
    legacy.close();
    // require is deliberate: module replacement must precede production imports.
    const { createDatabase } = require('../src/features/storage/database');
    const { createRepositories } = require('../src/features/storage/repositories');
    database = createDatabase({});
    const repos = createRepositories({ db: database.db, toPublicRoom: (room: any) => room });

    await t.test('old schema adds a nullable room binding without assigning global files', () => {
      const columns = database.db.prepare('PRAGMA table_info(soundpacks)').all() as any[];
      assert.ok(columns.some(column => column.name === 'roomId'));
      const row = database.db.prepare('SELECT * FROM soundpacks WHERE id = ?').get('old-global');
      assert.equal(row.roomId, null);
      assert.equal(row.filename, 'old-global.wav');
      assert.equal(row.normalizationVersion, 0);
      assert.deepEqual(repos.stmtGetSoundpacks.all('room-a'), []);
      assert.equal(repos.stmtGetSoundpack.get('old-global', 'room-a'), undefined);
      assert.equal(repos.stmtGetLegacySoundpacks.all().some((pack: any) => pack.id === 'old-global'), false);
    });

    database.db.prepare('INSERT INTO rooms (id, name, createdAt) VALUES (?, ?, ?)').run('room-a', 'A', 1);
    database.db.prepare('INSERT INTO rooms (id, name, createdAt) VALUES (?, ?, ?)').run('room-b', 'B', 2);
    repos.stmtInsertSoundpack.run('pack-a', 'Pack A', 'a.mp3', 'a.wav', 'Uploader A', 'account:a', 10, 10, 'room-a');
    repos.stmtInsertSoundpack.run('pack-b', 'Pack B', 'b.mp3', 'b.wav', 'Uploader B', 'account:b', 20, 20, 'room-b');

    await t.test('list and lookup bind both resource and room', () => {
      assert.deepEqual(repos.stmtGetSoundpacks.all('room-a').map((pack: any) => pack.id), ['pack-a']);
      assert.deepEqual(repos.stmtGetSoundpacks.all('room-b').map((pack: any) => pack.id), ['pack-b']);
      assert.equal(repos.stmtGetSoundpack.get('pack-b', 'room-a'), undefined);
      assert.equal(repos.stmtGetSoundpack.get('pack-a', 'room-b'), undefined);
      assert.equal(repos.stmtGetSoundpack.get('pack-a', 'room-a').roomId, 'room-a');
    });

    await t.test('wrong-room rename, delete, reorder and normalization cannot mutate a foreign row', () => {
      assert.equal(Number(repos.stmtRenameSoundpack.run('Foreign rename', 'pack-b', 'room-a').changes), 0);
      assert.equal(Number(repos.stmtDeleteSoundpack.run('pack-b', 'room-a').changes), 0);
      // A repository may reject invalid ids or safely perform no matching update.
      try { repos.reorderSoundpacks('room-a', ['pack-b']); } catch { /* Assert persisted state below. */ }
      let foreign = repos.stmtGetSoundpack.get('pack-b', 'room-b');
      assert.equal(foreign.name, 'Pack B');
      assert.equal(foreign.sortOrder, 20);
      database.db.prepare('UPDATE soundpacks SET normalizationVersion = 0 WHERE id = ?').run('pack-b');
      assert.equal(Number(repos.stmtMarkSoundpackNormalized.run('foreign.mp3', 'foreign.wav', 'pack-b', 'b.mp3', 'room-a').changes), 0);
      foreign = repos.stmtGetSoundpack.get('pack-b', 'room-b');
      assert.equal(foreign.filename, 'b.mp3');
      assert.equal(foreign.normalizationVersion, 0);
      assert.deepEqual(repos.stmtGetLegacySoundpacks.all().map((pack: any) => pack.id), ['pack-b']);
      assert.equal(Number(repos.stmtMarkSoundpackNormalized.run('b.normalized.mp3', 'b.wav', 'pack-b', 'b.mp3', 'room-b').changes), 1);
      assert.equal(Number(repos.stmtRenameSoundpack.run('Renamed A', 'pack-a', 'room-a').changes), 1);
      repos.reorderSoundpacks('room-a', ['pack-a']);
      assert.equal(repos.stmtGetSoundpack.get('pack-a', 'room-a').sortOrder, 0);
    });

    await t.test('reorders more than 500 rows atomically without touching another room', () => {
      database.db.prepare('INSERT INTO rooms (id, name, createdAt) VALUES (?, ?, ?)').run('room-large', 'Large', 3);
      const ids = Array.from({ length: 501 }, (_, index) => `large-${index}`);
      for (const [index, id] of ids.entries()) {
        repos.stmtInsertSoundpack.run(id, id, `${id}.mp3`, `${id}.wav`, 'Uploader', 'account:a', index, index, 'room-large');
      }
      const ordered = [...ids].reverse();
      repos.reorderSoundpacks('room-large', ordered);
      assert.deepEqual(repos.stmtGetSoundpacks.all('room-large').map((pack: any) => pack.id), ordered);
      assert.equal(repos.stmtGetSoundpack.get('pack-b', 'room-b').sortOrder, 20);
    });

    await t.test('room bindings and historical quarantine survive reopening the database', () => {
      database.db.close();
      database = undefined;
      database = createDatabase({});
      const reopened = createRepositories({ db: database.db, toPublicRoom: (room: any) => room });
      assert.equal(reopened.stmtGetSoundpack.get('pack-a', 'room-a').name, 'Renamed A');
      assert.equal(reopened.stmtGetSoundpack.get('pack-a', 'room-b'), undefined);
      assert.equal(reopened.stmtGetSoundpack.get('pack-b', 'room-b').filename, 'b.normalized.mp3');
      assert.equal(database.db.prepare('SELECT roomId FROM soundpacks WHERE id = ?').get('old-global').roomId, null);
      assert.equal(Number(reopened.stmtDeleteSoundpack.run('pack-a', 'room-a').changes), 1);
      assert.ok(reopened.stmtGetSoundpack.get('pack-b', 'room-b'));
    });
  } finally {
    database?.db.close();
    // Also close a handle if a migration threw before createDatabase returned.
    for (const opened of TestDatabase.open) opened.close();
    (Module as any)._load = originalLoad;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('cove-soundpack-storage-'));
    await rm(dataDir, { recursive: true, force: true });
  }
});
