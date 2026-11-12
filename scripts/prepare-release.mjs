import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const appRoot=fileURLToPath(new URL('../',import.meta.url));
const rootFiles=['package.json','package-lock.json','tsconfig.json','.gitignore','.gitattributes','.env.example','README.md','UPSTREAM.md','research-skills.md','LICENSE','LICENSE.md','NOTICE','NOTICE.md','THIRD_PARTY_NOTICES.md'];
const scripts=['scripts/dev.mjs','scripts/startup-config.mjs','scripts/prepare-release.mjs'];
const nativeAssets=['server/native/recycle.ps1'];
const skillIds=['literature-review','citation-management','arxiv'];
const legalFile=/^(?:LICENSE|NOTICE|THIRD_PARTY_NOTICES)(?:\.[A-Za-z]+)?$/i;
const sourceFile=/\.(?:ts|tsx|css|svg)$/i;
const excludedFile=/^(?:AGENTS|CLAUDE|CODEX)(?:\..*)?$/i;
const excludedDirectory=new Set(['node_modules','tests','tmp','test-results','uploads','sessions','artifacts']);
const required=['package.json','package-lock.json','tsconfig.json','.env.example','.gitignore','README.md','UPSTREAM.md','THIRD_PARTY_NOTICES.md','server/index.ts','server/app.ts','server/methods.ts','server/research-skills.ts','server/upstream/research-session-runtime.ts','server/upstream/LICENSE','shared/types.ts','web/app/page.tsx','web/app/layout.tsx','web/app/styles.css','web/next.config.ts','web/tsconfig.json',...scripts,...nativeAssets,...skillIds.map(id=>`server/upstream/research-skills/${id}/SKILL.md`)];
const inside=(base,target)=>{const relative=path.relative(base,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};

function filesForRelease(root){
 const files=new Set();
 const add=relative=>{const file=path.join(root,relative),stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())throw new Error(`发布文件必须是普通文件：${relative}`);files.add(relative.replaceAll('\\','/'));};
 for(const relative of [...rootFiles,...scripts,'web/next.config.ts','web/tsconfig.json'])if(fs.existsSync(path.join(root,relative)))add(relative);
 const walk=(relative,accept)=>{
  const directory=path.join(root,relative);if(!fs.existsSync(directory))return;
  if(fs.lstatSync(directory).isSymbolicLink())throw new Error(`发布目录不能使用链接：${relative}`);
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
   if(entry.name.startsWith('.')||excludedDirectory.has(entry.name)||excludedFile.test(entry.name))continue;
   const child=`${relative}/${entry.name}`;
   if(entry.isSymbolicLink())throw new Error(`发布目录不能包含链接：${child}`);
   if(entry.isDirectory())walk(child,accept);
   else if(entry.isFile()&&!/\.(?:test|spec)\.[^.]+$/.test(entry.name)&&accept(child,entry.name))add(child);
  }
 };
 walk('server',(relative,name)=>name.endsWith('.ts')||legalFile.test(name)||name==='README.md'||nativeAssets.includes(relative)||skillIds.some(id=>relative===`server/upstream/research-skills/${id}/SKILL.md`));
 walk('shared',(_relative,name)=>name.endsWith('.ts'));
 walk('methods',(_relative,name)=>/^\d{2}-.+\.md$/.test(name));
 for(const directory of ['web/app','web/components','web/lib'])walk(directory,(_relative,name)=>sourceFile.test(name));
 for(const relative of required)if(!files.has(relative))throw new Error(`缺少发布必需文件：${relative}`);
 for(let index=0;index<=14;index++){
  const prefix=`methods/${String(index).padStart(2,'0')}-`;
  if([...files].filter(file=>file.startsWith(prefix)).length!==1)throw new Error(`缺少或重复的内置方法卡：${prefix}`);
 }
 return [...files].sort();
}

/** Build an inspectable source release; never scan data dirs, delete, or overwrite. */
export async function prepareRelease({sourceRoot=appRoot,outputRoot,dryRun=false}={}){
 if(!outputRoot)throw new Error('请指定 --output 发布目录');
 const root=path.resolve(sourceRoot),output=path.resolve(outputRoot);
 if(output===root||inside(output,root)||['server','shared','methods','web','scripts'].some(directory=>output===path.join(root,directory)||inside(path.join(root,directory),output)))throw new Error('发布目录不能覆盖源目录或位于产品源码目录中');
 if(fs.existsSync(output))throw new Error('发布目录已存在；请使用一个新的空路径，脚本不会覆盖或删除文件');
 const selected=filesForRelease(root),contents=new Map();
 for(const relative of selected){
  let bytes=fs.readFileSync(path.join(root,relative));
  if(relative==='package.json'){
   const pkg=JSON.parse(bytes.toString('utf8'));
   pkg.scripts=Object.fromEntries(Object.entries(pkg.scripts??{}).filter(([name])=>['dev','start','server','web','build','typecheck','prepare:release'].includes(name)));
   bytes=Buffer.from(JSON.stringify(pkg,null,2)+'\n');
  }
  contents.set(relative,bytes);
 }
 const manifest={version:1,packageName:JSON.parse(contents.get('package.json').toString('utf8')).name,files:[...contents].map(([relative,bytes])=>({path:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}))};
 if(!dryRun){
  fs.mkdirSync(output,{recursive:true});
  for(const [relative,bytes] of contents){const target=path.join(output,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});}
  fs.writeFileSync(path.join(output,'RELEASE-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 }
 return manifest;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),outputIndex=args.indexOf('--output');
 if(args.some((arg,index)=>arg!=='--dry-run'&&arg!=='--output'&&index!==outputIndex+1)||outputIndex<0||!args[outputIndex+1]||args[outputIndex+1].startsWith('--'))throw new Error('用法：node scripts/prepare-release.mjs --output <新目录> [--dry-run]');
 const manifest=await prepareRelease({outputRoot:args[outputIndex+1],dryRun:args.includes('--dry-run')});
 console.log(JSON.stringify({dryRun:args.includes('--dry-run'),fileCount:manifest.files.length,totalBytes:manifest.files.reduce((sum,file)=>sum+file.bytes,0),files:manifest.files.map(file=>file.path)},null,2));
}
