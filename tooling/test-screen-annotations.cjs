const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const width = process.argv[2] || '1440';
if (!/^(1100|1440)$/.test(width)) throw new Error('Use an acceptance viewport of 1100 or 1440');
const env = {...process.env, COVE_UI_QA_WIDTH:width,
  COVE_UI_QA_ARTIFACTS:path.join(root,'runtime/ui-annotation-interactions',width),
  COVE_UI_QA_URL:'http://127.0.0.1:55373/tests/ui/share-chat-qa.html?layout-animation'};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ASAR;
const args = [path.join(root,'apps/desktop/tests/ui/screen-annotations.cjs')];
// Diagnostic test-process-only option; never used in the packaged application.
if (process.argv.includes('--diagnostic-no-sandbox')) args.unshift('--no-sandbox');
const result = spawnSync(require(path.join(root,'apps/desktop/node_modules/electron')),args,
  {env,cwd:path.join(root,'apps/desktop'),stdio:'inherit',windowsHide:true,timeout:100000});
if (result.error) console.error(result.error.message);
process.exit(result.status === 0 ? 0 : 1);
