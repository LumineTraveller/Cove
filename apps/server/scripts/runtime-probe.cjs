'use strict';

// Deliberately does not import server/index or create a profile, listener or tray.
// Invoked only by native-runtime.cjs with Electron's existing run-as-Node mode.
const path = require('node:path');
const expectedVersion = process.argv[2];
const moduleDirectory = process.argv[3];
const result = {
  ok: false,
  expectedElectron: expectedVersion,
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  modules: process.versions.modules,
  sqlite: 'not-checked',
};
try {
  if (result.electron !== expectedVersion) throw new Error('Electron executable does not match the selected runtime');
  const Database = require(path.join(moduleDirectory, 'lib', 'index.js'));
  const database = new Database(':memory:');
  try {
    database.exec('CREATE TABLE probe (value INTEGER NOT NULL)');
    database.prepare('INSERT INTO probe VALUES (?)').run(7);
    if (database.prepare('SELECT value FROM probe').get().value !== 7) throw new Error('SQLite round-trip failed');
  } finally { database.close(); }
  result.sqlite = 'passed';
  result.ok = true;
} catch (error) {
  result.sqlite = 'failed';
  result.error = error instanceof Error ? error.message : String(error);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 2);
