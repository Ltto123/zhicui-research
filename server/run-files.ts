import fs from 'node:fs';
import path from 'node:path';
import {atomicJson} from './upstream/atomic-json';
import {validateManagedTree} from './windows-recycle';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registeredArtifactOutputs(root:string,runId:string):string[]{
 if(!uuid.test(runId))throw new Error('任务文件归属标识无效');
 const file=path.join(root,'run-files',runId+'.json');
 const directory=path.dirname(file);if(fs.existsSync(directory))validateManagedTree(directory,root);
 if(!fs.existsSync(file))return [];
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('任务文件归属记录异常，未清理文件');
 const value=JSON.parse(fs.readFileSync(file,'utf8'));
 if(value.version!==1||value.runId!==runId||!Array.isArray(value.artifactIds)||value.artifactIds.some((id:unknown)=>typeof id!=='string'||!uuid.test(id)))throw new Error('任务文件归属记录无效，未清理文件');
 return [...new Set<string>(value.artifactIds)];
}
/** Record ownership before the first export write, including partial failures. */
export function registerArtifactOutput(root:string,runId:string,artifactId:string):void{
 if(!uuid.test(artifactId))throw new Error('成果文件归属标识无效');
 atomicJson(path.join(root,'run-files',runId+'.json'),{version:1,runId,artifactIds:[...new Set([...registeredArtifactOutputs(root,runId),artifactId])]});
}
