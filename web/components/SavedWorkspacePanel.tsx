'use client';
import {useContext,useEffect,useRef,useState} from 'react';
import type {SavedWorkspace} from '../../shared/workspace';
import {api,errorText} from '../lib/api';
import {LibraryPanel,type LibraryDraft} from './LibraryPanel';
import {WorkspaceDialog} from './WorkspaceTree';
import {SourceReturnContext} from './SourceLink';
import {readWorkspaceReturn,workspaceReturnHref} from '../lib/workspace-return';
export function SavedWorkspacePanel({onClose,initialLibraryId,onLibraryChange}:{onClose:()=>void;initialLibraryId?:string;onLibraryChange?:(id:string|undefined)=>void}){
  const parentReturnTo=useContext(SourceReturnContext);
  const [saved,setSaved]=useState<SavedWorkspace>(),[error,setError]=useState(''),[library,setLibrary]=useState(initialLibraryId??''),[refresh,setRefresh]=useState(0);
  const drafts=useRef(new Map<string,LibraryDraft>());
  useEffect(()=>{const abort=new AbortController();api<SavedWorkspace>('/workspace/saved',{signal:abort.signal}).then(setSaved).catch(e=>{if(!abort.signal.aborted)setError(errorText(e));});return()=>abort.abort();},[]);
  const returnTo=workspaceReturnHref({...readWorkspaceReturn(parentReturnTo??'/'),saved:true,savedLibraryId:library||undefined});
  return <SourceReturnContext.Provider value={returnTo}><WorkspaceDialog title="已保存资料" onClose={onClose}><p className="muted">上传材料、文献夹收藏与已保存成果集中在这里。项目移除后，保留的资料仍可访问。</p>{error&&<p role="alert">{error}</p>}{!saved&&!error?<p>正在加载…</p>:saved&&<div className="saved-workspace">{saved.projects.map(p=>{const artifacts=saved.artifacts.filter(a=>a.projectId===p.id),materials=saved.materials.filter(m=>m.projectId===p.id),count=saved.libraryCounts.find(c=>c.projectId===p.id)?.count??0;return <section key={p.id}><h3>{p.name}{p.removedAt&&<small>项目已移除</small>}</h3>{!artifacts.length&&!materials.length&&!count&&<p className="muted">暂无已保存资料</p>}{materials.map(m=><a key={m.id} href={`/api/materials/${encodeURIComponent(m.id)}/download`} download>{m.name}<span>上传材料 · 下载</span></a>)}{artifacts.map(({artifact})=><div className="saved-artifact" key={artifact.id}><strong>{artifact.title}</strong><div>{artifact.formats.map(format=><a key={format} href={`/api/artifacts/${encodeURIComponent(artifact.id)}/${format}`} download>{format.toUpperCase()}</a>)}</div></div>)}{count>0&&<button className="secondary-button" onClick={()=>{const next=library===p.id?'':p.id;setLibrary(next);onLibraryChange?.(next||undefined);}}>文献夹 · {count} 条</button>}{library===p.id&&<LibraryPanel projectId={p.id} refreshKey={refresh} drafts={drafts.current} onChanged={()=>setRefresh(v=>v+1)}/>}</section>})}{!saved.projects.length&&<p>尚无已保存资料。</p>}</div>}</WorkspaceDialog></SourceReturnContext.Provider>;
}
