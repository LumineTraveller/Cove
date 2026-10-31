'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const adapters=require('./source-adapters.cjs');
const original=path.join(adapters.root,'apps/desktop/tests/ui/screen-performance.electron.cjs');
const entry=new Module(original,module);entry.filename=original;entry.paths=Module._nodeModulePaths(path.dirname(original));
entry._compile(adapters.electron(fs.readFileSync(original,'utf8')),original);
