import fs from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';

const fields=new Set(['LLM_BACKEND','LLM_PROTOCOL','LLM_BASE_URL','LLM_MODEL','LLM_API_KEY','ZHICUI_PROVIDER','ZHICUI_NETWORK_MODE','ZHICUI_DATA_DIR','ZHICUI_PUBLIC_URL','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NCBI_EMAIL','NCBI_API_KEY']);

export function assertSupportedNode(version=process.versions.node){
 const [major,minor]=version.split('.').map(Number);
 if(!Number.isInteger(major)||!Number.isInteger(minor)||major<22||major===22&&minor<19)throw new Error('请使用 Node.js 22.19 或更新版本');
}

/** Load only this installation's settings. Explicit process values take priority. */
export function loadAppEnvironment(root,env=process.env){
 const file=path.join(root,'.env');if(!fs.existsSync(file))return;
 for(const [key,value] of Object.entries(parseEnv(fs.readFileSync(file,'utf8'))))if(fields.has(key)&&env[key]===undefined)env[key]=value;
}
