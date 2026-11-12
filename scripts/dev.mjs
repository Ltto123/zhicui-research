import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {assertSupportedNode,loadAppEnvironment} from './startup-config.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
assertSupportedNode();
loadAppEnvironment(root);
const production=process.argv.includes('--production');
const children=[spawn(process.execPath,['--import','tsx',path.join(root,'server/index.ts')],{cwd:root,stdio:'inherit',windowsHide:true}),spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),production?'start':'dev',path.join(root,'web'),'--hostname','127.0.0.1','--port','3000'],{cwd:root,stdio:'inherit',windowsHide:true})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children){if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}setTimeout(()=>process.exit(code),500);}
for(const child of children)child.on('exit',code=>{if(!stopping)stop(code??1);});
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
