'use strict';
const fs=require('node:fs'),path=require('node:path');
const {root,productController,productChat,fixtureObserver}=require('./source-adapters.cjs');
const normalized=value=>value.replace(/\\/g,'/');
exports.fullProductPlugin=()=>({name:'cove-isolated-full-product-commit-bridge',enforce:'pre',load(id){
  const file=normalized(id).split('?')[0];
  for(const [relative,transform] of [['apps/desktop/src/features/rooms/useRoomController.ts',productController],
    ['apps/desktop/src/features/chat/ChatPanelV2.tsx',productChat],
    ['apps/desktop/tests/ui/screen-performance-fixture.ts',fixtureObserver]]){
    const expected=normalized(path.join(root,relative));
    if(file!==expected)continue;
    if(normalized(id)!==expected)throw Error('Full App instrumentation requires one fixed original module id');
    return {code:transform(fs.readFileSync(path.join(root,relative),'utf8')),map:null};
  }
  return null;
}});
