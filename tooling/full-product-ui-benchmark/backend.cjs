'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const {root}=require('./source-adapters.cjs');
const namespace='fps-validation-full-ui-20261029';
if(process.env.COVE_FPS_RUNTIME_NAME!==namespace)throw Error('Invalid full App backend namespace');
const directory=path.resolve(process.env.COVE_FPS_RUN_DIR??'');
const relative=path.relative(path.join(root,'runtime',namespace),directory);
if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('Invalid full App backend directory');
const send=process.send?.bind(process);
if(!send)throw Error('Owned full App backend IPC is required');
let seeded=false;
process.send=function(message,...args){
  if(message?.type==='ready'){
    if(seeded)throw Error('Duplicate full App backend ready');seeded=true;
    const dbFile=path.join(directory,'backend-data','cove.db');
    if(!fs.existsSync(dbFile)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(message.base)||message.accounts?.length!==2)throw Error('Invalid owned backend seed contract');
    const Database=createRequire(path.join(root,'apps/server/package.json'))('better-sqlite3');
    const db=new Database(dbFile);
    try{
      const insert=db.prepare('INSERT INTO messages (id, roomId, author, authorId, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.transaction(()=>{for(let n=0;n<200;n++){const account=message.accounts[n%2].account;
        insert.run('full-ui-message-'+String(n).padStart(4,'0'),message.roomId,account.username,'account:'+account.id,
          'Synthetic performance message '+String(n).padStart(4,'0')+' — deterministic text and https://example.test/fixture/'+n,'chat',Date.UTC(2026,9,1)+n*1000);}})();
      const count=db.prepare("SELECT COUNT(*) AS count FROM messages WHERE roomId=? AND type='chat'").get(message.roomId).count;
      if(count!==200)throw Error('Full App message seed count mismatch');
      message={...message,fullProductUiSeed:{syntheticMessages:count}};
    }finally{db.close();}
  }
  return send(message,...args);
};
require(path.join(root,'apps/desktop/tests/ui/screen-performance-backend.cjs'));
