import {createHash} from 'node:crypto';
import type {Evidence,Run} from '../shared/types';
import type {LibraryItem,LibraryReadScope} from '../shared/library';
import type {PaperLibraryItem,PaperLibraryPage,PaperOrigin} from '../shared/paper-library';
import {LibraryStore,normalizeDoi,sourceContent} from './library';
import {publicDocumentUrl} from './public-article';
import {savedPaperResourceLookup} from './sources';
import type {Store} from './store';

export interface PaperQuery {
  conversationId?:string;
  q?:string;
  scope?:LibraryReadScope;
  resource?:'reader'|'cached_pdf'|'external';
  offset:number;
  limit:number;
}
const rank:Record<LibraryReadScope,number>={metadata:0,abstract:1,full_text:2};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,32);
const tidy=(value:unknown)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim()||undefined:undefined;
const fold=(value:string)=>value.normalize('NFKC').toLowerCase();
function publicLink(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>4000||/[\\\u0000-\u001f\u007f]/.test(value))return;
  try{return publicDocumentUrl(value,true).href;}catch{return;}
}
function preprintIdentity(url:string|undefined):string|undefined {
  if(!url)return;
  const parsed=new URL(url);
  if(!/^(?:(?:www|export)\.)?arxiv\.org$/i.test(parsed.hostname))return;
  const match=/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i.exec(parsed.pathname);
  if(match)return 'arxiv:'+match[1].toLowerCase();
}
function originKey(origin:Pick<PaperOrigin,'conversationId'|'runId'|'evidenceId'>){
  return JSON.stringify([origin.conversationId,origin.runId,origin.evidenceId]);
}
function candidates(run:Run):Evidence[] {
  return [run.retrieval,run.retrievalExpansion?.retrieval,...(run.retrievalExpansionHistory??[]).map(record=>record.retrieval)]
    .flatMap(record=>record?.pendingEvidence??[]);
}
type Occurrence={
  source:Evidence;origin:PaperOrigin;uniqueEvidence:boolean;notes:string[];
  url?:string;doi?:string;preprint?:string;
};
type Group={
  item:PaperLibraryItem;originKeys:Set<string>;collectableOrigins:Set<string>;urls:Set<string>;lastSeen:string;
  collectScope?:LibraryReadScope;
};
function samePublication(item:PaperLibraryItem,saved:LibraryItem):boolean {
  if(item.doi&&saved.doi&&item.doi!==saved.doi)return false;
  const version=preprintIdentity(item.url),savedVersion=preprintIdentity(publicLink(saved.url));
  return (!version&&!savedVersion)||version===savedVersion;
}
function indexSaved(index:Map<string,LibraryItem[]>,key:string,item:LibraryItem){
  const entries=index.get(key)??[];
  if(!entries.includes(item))entries.push(item);
  index.set(key,entries);
}
function onlySaved(entries:LibraryItem[]|undefined):LibraryItem|undefined {
  return entries?.length===1?entries[0]:undefined;
}

/** Bibliographic scope comes from the source bytes held by the run. A
 * screening decision, a generated note and a numeric search count contain
 * no additional paper resources. Only actual saved records become rows. */
export function listPapers(store:Store,projectId:string,query:PaperQuery):PaperLibraryPage {
  const project=store.getProject(projectId);
  if(project.removedAt)throw Object.assign(new Error('项目不存在'),{statusCode:404});
  const projectChats=store.listConversations(projectId);
  const chats=query.conversationId?projectChats.filter(chat=>chat.id===query.conversationId):projectChats;
  if(query.conversationId&&!chats.length)throw Object.assign(new Error('当前项目中找不到该对话'),{statusCode:404});

  const occurrences:Occurrence[]=[];
  const linkedDois=new Map<string,Set<string>>();
  // The source and collection endpoints resolve by run ID. An ambiguous
  // historical ID must not open a source in another conversation or project.
  const runCounts=new Map<string,number>();
  for(const chat of store.allConversations())for(const run of chat.runs)runCounts.set(run.id,(runCounts.get(run.id)??0)+1);
  for(const chat of chats)for(const run of chat.runs){
    if(run.conversationId!==chat.id)continue;
    const ids=new Map<string,number>(),notes=new Map<string,string[]>();
    for(const evidence of run.evidence)ids.set(evidence.id,(ids.get(evidence.id)??0)+1);
    for(const entry of run.reading?.entries??[])notes.set(entry.evidenceId,[...(notes.get(entry.evidenceId)??[]),entry.notes]);
    const add=(source:Evidence,kind:PaperOrigin['kind'])=>{
      if(!source||source.materialId||!['abstract','full_text','metadata'].includes(source.readScope)||!tidy(source.title))return;
      const rawUrl=publicLink(source.url),declaredDoi=normalizeDoi(source.doi),addressDoi=normalizeDoi(rawUrl);
      const doi=declaredDoi??addressDoi;
      const url=declaredDoi&&addressDoi&&declaredDoi!==addressDoi?undefined:rawUrl;
      if(['dataset','software','paratext'].includes(source.publicationType?.toLowerCase()??'')||/^10\.6084\/m9\.figshare\.c\.\d+(?:\.v\d+)?$/i.test(doi??''))return;
      const preprint=preprintIdentity(url);
      if(url&&doi){
        const identity=preprint??url;
        const known=linkedDois.get(identity)??new Set<string>();known.add(doi);linkedDois.set(identity,known);
      }
      occurrences.push({source,url,doi,preprint,origin:{conversationId:chat.id,conversationTitle:chat.title,runId:run.id,evidenceId:source.id,kind},
        uniqueEvidence:kind==='evidence'&&ids.get(source.id)===1&&runCounts.get(run.id)===1&&uuid.test(run.id)
          &&typeof source.id==='string'&&source.id.length>0&&source.id.length<=200&&!/[\u0000-\u001f\u007f]/.test(source.id),
        notes:notes.get(source.id)??[]});
    };
    for(const source of run.evidence)add(source,'evidence');
    for(const source of candidates(run))add(source,'candidate');
  }

  const lookup=savedPaperResourceLookup(store),groups=new Map<string,Group>();
  for(const occurrence of occurrences){
    const {source,origin,url,preprint}=occurrence;
    const known=url?linkedDois.get(preprint??url):undefined;
    const doi=occurrence.doi??(known?.size===1?[...known][0]:undefined);
    const sourceUrl=known&&known.size>1?undefined:url;
    // Prefer an explicitly versioned arXiv record to its journal DOI. Titles
    // alone, or an address shared by two conflicting DOIs, are not identities.
    const versionKey=preprint&&(!known||known.size<=1)?preprint:preprint&&doi?preprint+':doi:'+doi:undefined;
    const key=versionKey??(doi?'doi:'+doi:url&&(!known||known.size<=1)?'url:'+url:
      'origin:'+JSON.stringify([origin.runId,source.id,source.title,source.authors,source.year]));
    const content=sourceContent(source,occurrence.notes);
    const viewable=occurrence.uniqueEvidence&&/^[a-z0-9_-]{1,200}$/i.test(source.id);
    const local=viewable?lookup(source,content.readScope==='full_text',occurrence.notes):undefined;
    const available=local?'full_text':content.readScope;
    let group=groups.get(key);
    if(!group){
      group={originKeys:new Set(),collectableOrigins:new Set(),urls:new Set(),lastSeen:'',item:{id:digest(key),title:tidy(source.title)!,doi,url:sourceUrl,
        readScope:available,origins:[],resourceUrls:[],isCollected:false,canUpgradeCollection:false}};
      groups.set(key,group);
    }
    const item=group.item;
    item.authors??=tidy(source.authors);item.journal??=tidy(source.journal);item.year??=tidy(source.year);
    item.publicationType??=tidy(source.publicationType);
    item.abstract??=content.abstract;item.url??=sourceUrl;item.doi??=doi;
    if(rank[available]>rank[item.readScope])item.readScope=available;
    if(source.retrievedAt>group.lastSeen)group.lastSeen=source.retrievedAt;
    const identity=originKey(origin);
    if(occurrence.uniqueEvidence)group.collectableOrigins.add(identity);
    if(!group.originKeys.has(identity)){
      item.origins.push(origin);group.originKeys.add(identity);
    }else if(origin.kind==='evidence'){
      const old=item.origins.find(candidate=>originKey(candidate)===identity);
      if(old?.kind==='candidate')old.kind='evidence';
    }
    if(occurrence.uniqueEvidence&&(group.collectScope===undefined||rank[content.readScope]>rank[group.collectScope])){
      item.collectOrigin=origin;group.collectScope=content.readScope;
    }
    for(const candidate of source.fullTextUrls??[]){
      const link=publicLink(candidate),linkDoi=normalizeDoi(link);
      if(link&&(!doi||!linkDoi||doi===linkDoi)&&(linkedDois.get(preprintIdentity(link)??link)?.size??0)<=1)group.urls.add(link);
    }
    if(local){
      const queryString=new URLSearchParams({runId:origin.runId,evidenceId:origin.evidenceId});
      item.readerUrl??='/source?'+queryString.toString();
      if(local.pdfFile)item.cachedPdfUrl??='/api/runs/'+encodeURIComponent(origin.runId)+'/evidence/'+encodeURIComponent(origin.evidenceId)+'/document';
    }
  }
  const byOrigin=new Map<string,LibraryItem[]>(),byDoi=new Map<string,LibraryItem[]>(),byUrl=new Map<string,LibraryItem[]>();
  for(const saved of new LibraryStore(store).list(projectId)){
    for(const origin of saved.origins)indexSaved(byOrigin,originKey(origin),saved);
    if(saved.doi)indexSaved(byDoi,saved.doi,saved);
    const url=publicLink(saved.url);if(url)indexSaved(byUrl,url,saved);
  }
  for(const group of groups.values()){
    const item=group.item;item.resourceUrls=[...group.urls];
    const direct=[...group.collectableOrigins].map(origin=>onlySaved(byOrigin.get(origin)));
    const savedByUrl=item.url&&(linkedDois.get(item.url)?.size??0)<=1?onlySaved(byUrl.get(item.url)):undefined;
    const savedByDoi=item.doi?onlySaved(byDoi.get(item.doi)):undefined;
    const saved=[...direct,savedByUrl,savedByDoi].find(candidate=>candidate&&samePublication(item,candidate));
    item.isCollected=Boolean(saved);
    if(saved&&item.collectOrigin&&group.collectScope){
      const earlier=saved.origins.find(origin=>originKey(origin)===originKey(item.collectOrigin!));
      item.canUpgradeCollection=rank[group.collectScope]>rank[earlier?.readScope??saved.readScope];
    }
  }
  const terms=fold(query.q?.trim()??'').split(/\s+/).filter(Boolean);
  const filtered=[...groups.values()].filter(({item})=>{
    if(query.scope&&item.readScope!==query.scope)return false;
    if(query.resource==='reader'&&!item.readerUrl||query.resource==='cached_pdf'&&!item.cachedPdfUrl
      ||query.resource==='external'&&!item.url&&!item.doi&&!item.resourceUrls.length)return false;
    if(!terms.length)return true;
    const search=fold([item.title,item.authors,item.year,item.journal,item.doi,item.abstract].filter(Boolean).join(' '));
    return terms.every(term=>search.includes(term));
  }).sort((a,b)=>{
    const actual=(group:Group)=>Number(group.item.origins.some(origin=>origin.kind==='evidence'));
    return actual(b)-actual(a)||rank[b.item.readScope]-rank[a.item.readScope]
      ||b.lastSeen.localeCompare(a.lastSeen)||a.item.id.localeCompare(b.item.id);
  });
  return {items:filtered.slice(query.offset,query.offset+query.limit).map(group=>group.item),total:groups.size,
    matched:filtered.length,offset:query.offset,limit:query.limit};
}
