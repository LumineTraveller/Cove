import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

export interface CreateDatabaseDependencies {}

export function createDatabase(deps: CreateDatabaseDependencies) {
  const dataDir = process.env.COVE_DATA_DIR?.trim() || path.join(os.homedir(), '.cove');

  const dbPath = path.join(dataDir, 'cove.db');

  fs.mkdirSync(dataDir, { recursive: true });

  const configuredReleaseFilesDir = process.env.COVE_DOWNLOAD_DIR?.trim();

  const releaseFilesDir = configuredReleaseFilesDir
    ? path.resolve(configuredReleaseFilesDir)
    : process.platform === 'linux'
    ? '/var/www/cove-download'
    : path.join(dataDir, 'public');

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  db.pragma('foreign_keys = ON');

  db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    ownerId TEXT,
    ownerName TEXT,
    avatarUrl TEXT,
    backgroundTop TEXT,
    backgroundBottom TEXT,
    backgroundTopDark TEXT,
    backgroundBottomDark TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    roomId TEXT NOT NULL,
    author TEXT NOT NULL,
    authorId TEXT,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat',
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (roomId) REFERENCES rooms(id)
  );
  CREATE TABLE IF NOT EXISTS soundpacks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploader TEXT NOT NULL,
    uploaderId TEXT,
    createdAt INTEGER NOT NULL,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    originalFilename TEXT,
    normalizationVersion INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS room_mutes (
    roomId TEXT NOT NULL,
    clientId TEXT NOT NULL,
    username TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (roomId, clientId)
  );
`);

  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[];

  if (!roomColumns.some((column) => column.name === 'ownerId'))
    db.exec('ALTER TABLE rooms ADD COLUMN ownerId TEXT');

  if (!roomColumns.some((column) => column.name === 'ownerName'))
    db.exec('ALTER TABLE rooms ADD COLUMN ownerName TEXT');

  if (!roomColumns.some((column) => column.name === 'maxMembers'))
    db.exec('ALTER TABLE rooms ADD COLUMN maxMembers INTEGER');

  if (!roomColumns.some((column) => column.name === 'passwordHash'))
    db.exec('ALTER TABLE rooms ADD COLUMN passwordHash TEXT');

  if (!roomColumns.some((column) => column.name === 'passwordSalt'))
    db.exec('ALTER TABLE rooms ADD COLUMN passwordSalt TEXT');

  if (!roomColumns.some((column) => column.name === 'avatarUrl'))
    db.exec('ALTER TABLE rooms ADD COLUMN avatarUrl TEXT');

  if (!roomColumns.some((column) => column.name === 'backgroundTop'))
    db.exec('ALTER TABLE rooms ADD COLUMN backgroundTop TEXT');

  if (!roomColumns.some((column) => column.name === 'backgroundBottom'))
    db.exec('ALTER TABLE rooms ADD COLUMN backgroundBottom TEXT');

  if (!roomColumns.some((column) => column.name === 'backgroundTopDark'))
    db.exec('ALTER TABLE rooms ADD COLUMN backgroundTopDark TEXT');

  if (!roomColumns.some((column) => column.name === 'backgroundBottomDark'))
    db.exec('ALTER TABLE rooms ADD COLUMN backgroundBottomDark TEXT');

  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];

  if (!messageColumns.some((column) => column.name === 'type'))
    db.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'chat'");

  if (!messageColumns.some((column) => column.name === 'authorId'))
    db.exec('ALTER TABLE messages ADD COLUMN authorId TEXT');

  const soundpackColumns = db.prepare('PRAGMA table_info(soundpacks)').all() as { name: string }[];

  if (!soundpackColumns.some((column) => column.name === 'uploaderId'))
    db.exec('ALTER TABLE soundpacks ADD COLUMN uploaderId TEXT');

  if (!soundpackColumns.some((column) => column.name === 'sortOrder')) {
    db.exec('ALTER TABLE soundpacks ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0');
    const existing = db.prepare('SELECT id FROM soundpacks ORDER BY createdAt DESC').all() as {
      id: string;
    }[];
    const updateOrder = db.prepare('UPDATE soundpacks SET sortOrder = ? WHERE id = ?');
    db.transaction((rows: { id: string }[]) => {
      rows.forEach((row, index) => updateOrder.run(index, row.id));
    })(existing);
  }

  if (!soundpackColumns.some((column) => column.name === 'originalFilename'))
    db.exec('ALTER TABLE soundpacks ADD COLUMN originalFilename TEXT');

  if (!soundpackColumns.some((column) => column.name === 'normalizationVersion'))
    db.exec('ALTER TABLE soundpacks ADD COLUMN normalizationVersion INTEGER NOT NULL DEFAULT 0');
  return {
    dataDir,
    dbPath,
    configuredReleaseFilesDir,
    releaseFilesDir,
    db,
    roomColumns,
    messageColumns,
    soundpackColumns,
  };
}
