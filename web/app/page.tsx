'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, CircleHelp, FileCheck2, FileText, FolderOpen, Leaf, LoaderCircle, Menu, PanelLeftClose, PanelRightClose, PanelRightOpen, Paperclip, Plus, Settings2, Square, X } from 'lucide-react';
import type { ActiveModelSelection, Artifact, Conversation, Evidence, Material, ModelConnectionsState, Project, ProviderStatus, Run } from '../../shared/types';
import { api, body, errorText } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { Settings } from '../components/Settings';
import { ArgumentCard, scopeLabels } from '../components/ArgumentCard';
import {evidenceSourceHref} from '../lib/source-links';
import {awaitingWritingOutline,deriveRunProgress,evidenceInventory,outlineReviewDefault} from '../lib/run-progress';
import {ResearchProgress,RunContinuation,RunStageStatus} from '../components/ResearchProgress';
import { LibraryPanel, type LibraryDraft } from '../components/LibraryPanel';
import type { LibraryItem } from '../../shared/library';
import libraryStyles from '../components/LibraryPanel.module.css';
import {ModelPicker} from '../components/ModelPicker';
import {CopyMessageButton} from '../components/CopyMessageButton';
import {messageCopyText} from '../lib/message-copy';
import {modelConnectionActions,modelConnectionUpdates,selectedModelVerified} from '../lib/model-connections';
import {withAcceptedRun} from '../lib/accepted-run';
import {conversationSummaryChanged,currentRun,sameRunAction} from '../lib/current-run';
import {ResearchOptionsConfirmation} from '../components/ResearchOptionsConfirmation';
import {ArtifactUsageNotes,TaskRequirements} from '../components/TaskRequirements';
import type {ConversationSummary,WorkspaceIndex,WorkspaceSection} from '../../shared/workspace';
import {WorkspaceTree,type WorkspaceChange} from '../components/WorkspaceTree';
import {SavedWorkspacePanel} from '../components/SavedWorkspacePanel';
import {PaperLibrary} from '../components/PaperLibrary';
import {usePaperNavigation} from '../lib/paper-navigation';
import {acceptResearchOptions,confirmResearchOptions,invalidateResearchOptions,rebindResearchOptionsScope,researchOptionsSnapshot,researchOptionsStatus,type ResearchOptionsConfirmationState,type ResearchOptionsValues} from '../lib/research-options-confirmation';

const materialLabels: Record<Material['role'], string> = { evidence: '研究材料', method: '方法要求', format: '格式规范' };
const isRunning = (run?: Run) => run?.status === 'running' || run?.status === 'queued';
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const untouchedMethodFields = { mode: false, instructions: false, format: false, confirmation: false };
const staleRunMessage='当前任务已更新，已同步最新进度。请查看当前任务后再操作；尚未发送的内容已保留。';

function downloadEvidenceText(source: Evidence) {
  const url = URL.createObjectURL(new Blob([source.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `zhicui-evidence-${source.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Workspace() {
  const paperNavigation = usePaperNavigation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sections,setSections]=useState<WorkspaceSection[]>([]);
  const [savedOpen,setSavedOpen]=useState(false);
  const [savedArtifacts,setSavedArtifacts]=useState<Set<string>>(new Set());
  const [savingArtifact,setSavingArtifact]=useState('');
  const [draftFiles,setDraftFiles]=useState<{file:File;role:Material['role']}[]>([]);
  const [draftMaterialIds,setDraftMaterialIds]=useState<string[]>([]);
  const [conversation, setConversation] = useState<Conversation>();
  const conversationRef=useRef(conversation);conversationRef.current=conversation;
  const [materials, setMaterials] = useState<Material[]>([]);
  const [modelConnections, setModelConnections] = useState<ModelConnectionsState>();
  const modelUpdates=useRef<ReturnType<typeof modelConnectionUpdates>|null>(null);
  if(!modelUpdates.current)modelUpdates.current=modelConnectionUpdates(setModelConnections);
  const adoptModelConnections=useCallback((state:ModelConnectionsState)=>modelUpdates.current!.adopt(state),[]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [modelSelecting, setModelSelecting] = useState(false);
  const modelSelectionBusy = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [tab, setTab] = useState<'materials' | 'artifacts' | 'library'>('materials');
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [collecting, setCollecting] = useState('');
  const [collected, setCollected] = useState<{ projectId: string; evidenceKey: string; text: string }>();
  const libraryDrafts = useRef(new Map<string, LibraryDraft>());
  const collectionBusy = useRef(new Set<string>());
  const [selectedArtifactId, setSelectedArtifactId] = useState('');
  const [selectedMaterialId, setSelectedMaterialId] = useState('');
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('');
  const [draft, setDraft] = useState('');
  const [taskIntent, setTaskIntent] = useState<'continue' | 'new'>('continue');
  const [methodMode, setMethodMode] = useState<'auto' | 'supplement' | 'replace'>('auto');
  const [methodInstructions, setMethodInstructions] = useState('');
  const [formatInstructions, setFormatInstructions] = useState('');
  const [waitForConfirmation, setWaitForConfirmation] = useState(true);
  const [methodDirty, setMethodDirty] = useState(untouchedMethodFields);
  const [optionsConfirmation,setOptionsConfirmation]=useState<ResearchOptionsConfirmationState>({});
  const [acceptedOptions,setAcceptedOptions]=useState<{runId:string;values:ResearchOptionsValues}>();
  const optionsEditVersion=useRef(0),optionsVisit=useRef(0);
  const [uploadRole, setUploadRole] = useState<Material['role']>('evidence');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingMaterial, setPendingMaterial] = useState<{ id: string; selected: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pollWarning, setPollWarning] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const activeRef = useRef('');
  const projectRef = useRef('');
  const selectionVersion = useRef(0);
  const conversationReadVersion=useRef(0);
  const navigationVersion=useRef(0);
  const indexVersion=useRef(0);
  const managementBusy=useRef(false);
  const [managing,setManaging]=useState(false);
  const interruptedSelection=useRef<{id:string;navigationVersion:number}|undefined>(undefined);
  const creationPromise = useRef<Promise<Conversation> | null>(null);
  const requestBusy = useRef(false);
  const followScroll = useRef(true);
  const [showScroll, setShowScroll] = useState(false);

  const latestRun = currentRun(conversation?.runs??[]);
  const evidenceRun = latestRun ? deriveRunProgress(latestRun, conversation?.runs ?? []).displayRun : undefined;
  const inventory = evidenceInventory(evidenceRun?.evidence ?? []);
  const sourceLinks=useMemo(()=>[...(conversation?.runs??[])].reverse().flatMap(run=>run.evidence.map(source=>({runId:run.id,id:source.id,doi:source.doi,url:source.url,fullTextUrls:source.fullTextUrls}))),[conversation]);
  const running = isRunning(latestRun);
  const taskActive = running || latestRun?.status === 'awaiting_confirmation';
  const continuing = Boolean(latestRun) && taskIntent === 'continue';
  const taskContext = latestRun?.taskContext;
  const inheritedMethods = continuing ? latestRun?.plan?.methods : undefined;
  const acceptedValues=continuing&&acceptedOptions?.runId===latestRun?.id?acceptedOptions?.values:undefined;
  const displayedMethodMode = methodDirty.mode ? methodMode : acceptedValues?.methodMode ?? inheritedMethods?.mode ?? 'auto';
  const displayedMethodInstructions = methodDirty.instructions ? methodInstructions : acceptedValues?.methodInstructions ?? inheritedMethods?.instructions ?? '';
  const displayedFormatInstructions = methodDirty.format ? formatInstructions : acceptedValues?.formatInstructions ?? inheritedMethods?.formatInstructions ?? '';
  const displayedWaitForConfirmation = methodDirty.confirmation ? waitForConfirmation : acceptedValues?.waitForConfirmation ?? outlineReviewDefault(latestRun,continuing);
  const hasMethodChanges = Object.values(methodDirty).some(Boolean);
  const hasMaterialChanges=Boolean(latestRun)&&JSON.stringify([...(conversation?.materialIds??[])].sort())!==JSON.stringify([...latestRun!.materialIds].sort());
  const optionsScope=`${conversation?.id??`draft:${projectId}`}:${optionsVisit.current}`;
  // After acceptance the badge describes that submitted run. A later explicit
  // edit clears it; the composer returning to "continue" is not a user edit.
  const optionsValues:ResearchOptionsValues={methodMode:displayedMethodMode,methodInstructions:displayedMethodInstructions,formatInstructions:displayedFormatInstructions,waitForConfirmation:displayedWaitForConfirmation,materialIds:conversation?.materialIds??draftMaterialIds,taskIntent:acceptedValues&&optionsConfirmation.applied?acceptedValues.taskIntent:latestRun?taskIntent:'new'};
  const currentOptionsSnapshot=researchOptionsSnapshot(optionsScope,optionsEditVersion.current,optionsValues);
  const optionsValuesRef=useRef(optionsValues);optionsValuesRef.current=optionsValues;
  const optionsSnapshotRef=useRef(currentOptionsSnapshot);optionsSnapshotRef.current=currentOptionsSnapshot;
  const invalidateOptions=useCallback(()=>{optionsEditVersion.current++;setOptionsConfirmation(invalidateResearchOptions());},[]);
  const resetOptionsVisit=useCallback(()=>{optionsVisit.current++;optionsEditVersion.current++;setOptionsConfirmation(invalidateResearchOptions());setAcceptedOptions(undefined);},[]);
  const selectedArtifact = conversation?.artifacts.find(item => item.id === selectedArtifactId) ?? conversation?.artifacts.at(-1);
  const selectedArtifactRun = conversation?.runs.find(run => run.id === selectedArtifact?.runId);
  const selectedMaterial = materials.find(item => item.id === selectedMaterialId);
  const project = projects.find(item => item.id === projectId);

  const adoptConversation = useCallback((value: Conversation) => {
    ++conversationReadVersion.current;
    conversationRef.current=value;
    setConversation(value);
    setConversations(items => {
      const summary:ConversationSummary={id:value.id,projectId:value.projectId,title:value.title,createdAt:value.createdAt,updatedAt:value.updatedAt,pinned:value.pinned,archivedAt:value.archivedAt,unread:value.unread,sectionId:value.sectionId,latestStatus:value.runs.at(-1)?.status,messageCount:value.messages.length,artifactCount:value.artifacts.length};
      const next = [summary, ...items.filter(item => item.id !== value.id)];
      return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const refreshConversation=useCallback(async (id: string,signal?:AbortSignal) => {
    const version=selectionVersion.current,readVersion=++conversationReadVersion.current;
    const timeout=AbortSignal.timeout(25_000);
    const result = await api<Conversation>(`/conversations/${id}`,{cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout});
    if (!managementBusy.current&&conversationReadVersion.current===readVersion&&selectionVersion.current===version&&activeRef.current === id) adoptConversation(result);
    return result;
  },[adoptConversation]);

  const selectConversation = useCallback(async (id: string) => {
    ++navigationVersion.current;
    resetOptionsVisit();
    const version = ++selectionVersion.current;
    activeRef.current = id; setConversation(undefined); setLoading(true); setError(''); setPollWarning(false);
    setSelectedArtifactId(''); setSelectedMaterialId(''); setDraft(''); setDraftFiles([]);setDraftMaterialIds([]);setMaterials([]);setTaskIntent('continue'); setLeftOpen(false);
    setMethodInstructions(''); setFormatInstructions(''); setMethodMode('auto'); setWaitForConfirmation(true); setMethodDirty(untouchedMethodFields);
    followScroll.current = true;
    try {
      const result = await api<Conversation>(`/conversations/${id}`);
      if(selectionVersion.current!==version||activeRef.current!==id)return;
      projectRef.current=result.projectId;setProjectId(result.projectId);adoptConversation(result);
      // Loading the underlying chat must preserve an open paper-library link.
      window.history.replaceState(window.history.state, '', `/?conversation=${encodeURIComponent(id)}${window.location.hash}`);
      const files=await api<Material[]>(`/projects/${encodeURIComponent(result.projectId)}/materials`);
      if(selectionVersion.current===version&&activeRef.current===id)setMaterials(files);
    } catch (error) { if (selectionVersion.current === version) setError(errorText(error)); }
    finally { if (selectionVersion.current === version) setLoading(false); }
  }, [adoptConversation,resetOptionsVisit]);

  const selectProject = useCallback(async (id: string) => {
    ++navigationVersion.current;
    resetOptionsVisit();
    const version = ++selectionVersion.current;
    projectRef.current = id; activeRef.current = ''; setProjectId(id); setConversation(undefined);
    setMaterials([]); setLoading(true); setError(''); setDraft('');setDraftFiles([]);setDraftMaterialIds([]); setTaskIntent('continue'); setPollWarning(false);setLeftOpen(false);
    window.history.replaceState(null,'','/');
    setSelectedArtifactId(''); setSelectedMaterialId('');
    setMethodInstructions(''); setFormatInstructions(''); setMethodMode('auto'); setWaitForConfirmation(true); setMethodDirty(untouchedMethodFields);
    try {
      const files = await api<Material[]>(`/projects/${id}/materials`);
      if (selectionVersion.current !== version) return;
      setMaterials(files);
    } catch (error) { if (selectionVersion.current === version) setError(errorText(error)); }
    finally { if (selectionVersion.current === version) setLoading(false); }
  }, [resetOptionsVisit]);

  useEffect(() => {
    const abort = new AbortController();
    setRightOpen(window.innerWidth > 1190);
    const version=++indexVersion.current,navigationVersion=selectionVersion.current;
    const explicit=new URL(window.location.href).searchParams.get('conversation');
    api<WorkspaceIndex>('/workspace', { signal: abort.signal }).then(index => {
      if(abort.signal.aborted||indexVersion.current!==version)return;
      setProjects(index.projects);setConversations(index.conversations);setSections(index.sections);
      if(explicit&&selectionVersion.current===navigationVersion)void selectConversation(explicit);else setLoading(false);
    }).catch(error => { if (!abort.signal.aborted) { setError(errorText(error)); setLoading(false); } });
    modelUpdates.current!.read(()=>modelConnectionActions().load(abort.signal),abort.signal).catch(() => {});
    api<ProviderStatus[]>('/providers', { signal: abort.signal }).then(value=>{if(!abort.signal.aborted)setProviders(value);}).catch(() => {});
    return () => abort.abort();
  }, [selectConversation]);

  useEffect(() => {
    if (!conversation) return;
    const id = conversation.id;
    let cancelled = false,inFlight=false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const sync = async () => {
      if(cancelled||inFlight||document.visibilityState==='hidden'||managementBusy.current||requestBusy.current)return;
      inFlight=true;
      const version=selectionVersion.current,readVersion=conversationReadVersion.current;
      const stillSelected=()=>!cancelled&&!managementBusy.current&&selectionVersion.current===version&&activeRef.current===id;
      try {
        if(running)await refreshConversation(id,abort.signal);
        else{
          // Idle/outline views only read the lightweight index, not saved paper bodies.
          const index=await api<WorkspaceIndex>('/workspace',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)])});
          if(!stillSelected()||requestBusy.current||conversationReadVersion.current!==readVersion)return;
          const summary=index.conversations.find(value=>value.id===id),current=conversationRef.current;
          if(summary&&current?.id===id&&conversationSummaryChanged(current,summary))await refreshConversation(id,abort.signal);
        }
        if(stillSelected())setPollWarning(false);
      } catch { if(stillSelected())setPollWarning(true); }
      finally {inFlight=false;}
    };
    const poll=async()=>{await sync();if(!cancelled)timer=setTimeout(poll,running?1500:15_000);};
    const onFocus=()=>{void sync();};
    timer=setTimeout(poll,running?1000:15_000);
    window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onFocus);
    return () => { cancelled = true; clearTimeout(timer); abort.abort();window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onFocus); };
  }, [conversation?.id, running, refreshConversation]);

  useEffect(() => {
    if (followScroll.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation?.messages.length, latestRun?.events.length, latestRun?.status]);

  useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = 'auto';
    composer.current.style.height = `${Math.min(180, composer.current.scrollHeight)}px`;
  }, [draft]);

  useEffect(() => { setSelectedEvidenceId(''); }, [conversation?.id, latestRun?.id]);

  async function ensureConversation(): Promise<Conversation> {
    if (conversation && activeRef.current === conversation.id) return conversation;
    if (creationPromise.current) return creationPromise.current;
    const version = selectionVersion.current;
    creationPromise.current = (async () => {
      let id = projectRef.current;
      if (!id) {
        const created = await api<Project>('/workspace/default-project', { method: 'POST', body: '{}' });
        setProjects(items => [...items.filter(item=>item.id!==created.id), created]);
        if (selectionVersion.current === version) { setProjectId(created.id); projectRef.current = created.id; }
        id = created.id;
      }
      const created = await api<Conversation>(`/projects/${id}/conversations`, { method: 'POST', body: '{}' });
      if (selectionVersion.current === version) { activeRef.current = created.id; adoptConversation(created);window.history.replaceState(null,'',`/?conversation=${encodeURIComponent(created.id)}`); }
      return created;
    })();
    try { return await creationPromise.current; } finally { creationPromise.current = null; }
  }

  async function newConversation(targetProjectId?:string) {
    if (requestBusy.current || uploading) return;
    if(targetProjectId){await selectProject(targetProjectId);return;}
    ++navigationVersion.current;
    resetOptionsVisit();
    ++selectionVersion.current; activeRef.current = '';projectRef.current='';setProjectId('');setMaterials([]); setConversation(undefined); setDraft('');setDraftFiles([]);setDraftMaterialIds([]); setTaskIntent('continue');
    window.history.replaceState(null,'','/');
    setLoading(false); setPollWarning(false);
    setSelectedArtifactId(''); setSelectedMaterialId(''); setError(''); setLeftOpen(false); setTab('materials');
    setMethodInstructions(''); setFormatInstructions(''); setMethodMode('auto'); setWaitForConfirmation(true); setMethodDirty(untouchedMethodFields);
    composer.current?.focus();
  }

  async function refreshIndex(){const version=++indexVersion.current;const index=await api<WorkspaceIndex>('/workspace');if(indexVersion.current===version){setProjects(index.projects);setConversations(index.conversations);setSections(index.sections);}return index;}
  async function workspaceChanged(change:WorkspaceChange){
    const affectsCurrent=change.target.kind==='project'?(conversations.find(item=>item.id===activeRef.current)?.projectId??projectRef.current)===change.target.id:activeRef.current===change.target.id;
    if(change.navigationVersion===navigationVersion.current&&affectsCurrent&&['archive','delete'].includes(change.action))await newConversation();
    const index=await refreshIndex();
    if(change.navigationVersion!==navigationVersion.current)return;
    if(change.conversation){await selectConversation(change.conversation.id);return;}
    if(affectsCurrent&&activeRef.current){
      const summary=index.conversations.find(item=>item.id===activeRef.current);
      if(summary){if(!conversation)await selectConversation(summary.id);else setConversation(current=>current&&current.id===summary.id?{...current,title:summary.title,pinned:summary.pinned,archivedAt:summary.archivedAt,sectionId:summary.sectionId,unread:summary.unread}:current);}
    }
  }
  async function saveArtifact(artifact:Artifact){if(savingArtifact)return;setSavingArtifact(artifact.id);try{await api(`/artifacts/${encodeURIComponent(artifact.id)}/save`,{method:'POST',body:'{}'});setSavedArtifacts(old=>new Set([...old,artifact.id]));}catch(cause){setError(errorText(cause));}finally{setSavingArtifact('');}}

  async function send(intent = taskIntent, actionText = '') {
    const text = draft.trim() || actionText;
    if (managementBusy.current||conversation?.archivedAt||project?.archivedAt)return;
    if (!text || requestBusy.current || modelSelectionBusy.current || uploading || loading) return;
    if (intent === 'new' && taskActive) { setError('请先停止当前任务，再单独提问。补充要求可在执行中直接发送。'); return; }
    requestBusy.current = true; setSending(true); setError('');
    const version = selectionVersion.current;
    const submittedValues={...optionsValuesRef.current,materialIds:[...optionsValuesRef.current.materialIds]};
    let submittedSnapshot=optionsSnapshotRef.current;
    let targetId = activeRef.current;
    let submitted=false;
    try {
      let current = await ensureConversation();
      targetId = current.id;
      current=await refreshConversation(targetId);
      if(selectionVersion.current!==version||activeRef.current!==targetId)return;
      const currentTask=currentRun(current.runs);
      if(currentTask?.id!==latestRun?.id||(latestRun?.status==='awaiting_confirmation'&&!sameRunAction(latestRun,currentTask))){setError(staleRunMessage);return;}
      if(draftMaterialIds.length){
        current=await api<Conversation>(`/conversations/${targetId}/materials`,{method:'PUT',body:body({materialIds:draftMaterialIds})});
        // This selection is now saved. Retrying a later upload/sync failure
        // must not replace newly uploaded material IDs with the old draft list.
        setDraftMaterialIds([]);adoptConversation(current);
      }
      for(const queued of draftFiles){const data=new FormData();data.append('role',queued.role);data.append('file',queued.file);const material=await api<Material>(`/conversations/${targetId}/materials`,{method:'POST',body:data,signal:AbortSignal.timeout(90_000)});if(selectionVersion.current===version){setMaterials(old=>[...old.filter(m=>m.id!==material.id),material]);setDraftFiles(old=>old.filter(entry=>entry!==queued));}}
      if(draftMaterialIds.length||draftFiles.length){current=await refreshConversation(targetId);setDraftMaterialIds([]);}
      const wireIntent=current.runs.length?intent:'new';
      const targetScope=`${targetId}:${optionsVisit.current}`;
      if(submittedSnapshot.scopeKey!==targetScope){const rebound=rebindResearchOptionsScope(submittedSnapshot,submittedSnapshot.scopeKey,targetScope,optionsEditVersion.current,optionsValuesRef.current);if(rebound)submittedSnapshot=rebound;}
      submittedValues.taskIntent=wireIntent;
      submittedSnapshot=researchOptionsSnapshot(submittedSnapshot.scopeKey,submittedSnapshot.editVersion,submittedValues);
      submitted=true;
      const nextRun=await api<Run>(`/conversations/${targetId}/messages`, { method: 'POST', body: body({
        content: text, taskIntent: wireIntent, materialIds: current.materialIds,
        ...(latestRun?.status==='awaiting_confirmation'&&latestRun.confirmationToken?{expectedConfirmationToken:latestRun.confirmationToken}:{}),
        ...(methodDirty.mode ? { methodMode } : {}),
        ...(methodDirty.instructions ? { methodInstructions: methodInstructions.trim() } : {}),
        ...(methodDirty.format ? { formatInstructions: formatInstructions.trim() } : {}),
        ...(methodDirty.confirmation ? { waitForConfirmation } : {}),
      }) });
      if (selectionVersion.current === version && activeRef.current === targetId) {
        // Invalidate any focus/poll response that started before this acceptance.
        ++conversationReadVersion.current;
        const acceptedSnapshot=researchOptionsSnapshot(targetScope,optionsEditVersion.current,{...optionsValuesRef.current,taskIntent:wireIntent});
        setOptionsConfirmation(state=>acceptResearchOptions(state,submittedSnapshot,acceptedSnapshot,nextRun.id));
        setConversation(value=>value?withAcceptedRun(value,nextRun,text):value);
        setConversations(values=>values.map(value=>value.id===targetId?{...value,latestStatus:nextRun.status,messageCount:value.messageCount+1}:value));
        const unchanged=submittedSnapshot.scopeKey===acceptedSnapshot.scopeKey&&submittedSnapshot.editVersion===acceptedSnapshot.editVersion&&submittedSnapshot.fingerprint===acceptedSnapshot.fingerprint;
        if(unchanged){setAcceptedOptions({runId:nextRun.id,values:submittedValues});setMethodInstructions('');setFormatInstructions('');setMethodMode('auto');setWaitForConfirmation(true);setMethodDirty(untouchedMethodFields);}
        setDraft(value => value.trim() === text ? '' : value);
        setTaskIntent('continue');
        followScroll.current = true;
      }
      try{await refreshConversation(targetId);}catch{if(selectionVersion.current===version&&activeRef.current===targetId)setError('请求已接收，本轮设置已应用；后续刷新失败，请勿重复发送。正在等待状态同步，可稍后刷新页面查看。');}
    } catch (error) {
      if(submitted){try{await refreshConversation(targetId);}catch{/* Keep the submission error and never retry the POST. */}}
      if (selectionVersion.current === version && activeRef.current === targetId) setError(errorText(error));
    }
    finally { requestBusy.current = false; setSending(false); }
  }

  async function runAction(action: 'cancel' | 'resume') {
    if (!latestRun || requestBusy.current || managementBusy.current || uploading || loading) return;
    if(action==='resume'&&(modelSelectionBusy.current||conversation?.archivedAt||project?.archivedAt))return;
    if (action === 'resume' && (draft.trim() || hasMethodChanges || hasMaterialChanges)) { await send('continue', '设置调整：按已调整的方法、格式和所选材料继续当前任务。'); return; }
    const version = selectionVersion.current, targetId = latestRun.conversationId, targetRunId = latestRun.id;
    requestBusy.current = true; setSending(true); setError('');
    try {
      const current=await refreshConversation(targetId);
      if(selectionVersion.current!==version||activeRef.current!==targetId)return;
      if(!sameRunAction(latestRun,currentRun(current.runs))){setError(staleRunMessage);return;}
      const result = await api<Run>(`/runs/${targetRunId}/${action}`, { method: 'POST', body: body(action==='resume'&&latestRun.status==='awaiting_confirmation'&&latestRun.confirmationToken?{expectedConfirmationToken:latestRun.confirmationToken}:{}) });
      await refreshConversation(result.conversationId);
    } catch (error) {
      // A second client can change the task after preflight. Refresh on 409 (and
      // other failures) but never replay this action against the newly found run.
      try{await refreshConversation(targetId);}catch{/* Retain the original action error. */}
      if (selectionVersion.current === version && activeRef.current === targetId) setError(errorText(error));
    }
    finally { requestBusy.current = false; setSending(false); }
  }

  async function upload(files: FileList | null) {
    if (!files?.length || requestBusy.current || managementBusy.current || running || conversation?.archivedAt || project?.archivedAt) return;
    invalidateOptions();
    if(!conversation){const queued=Array.from(files).map(file=>({file,role:uploadRole}));setDraftFiles(old=>[...old,...queued]);setTab('materials');setRightOpen(true);if(fileInput.current)fileInput.current.value='';return;}
    requestBusy.current = true; setUploading(true); setError('');
    try {
      const current = await ensureConversation();
      for (const file of Array.from(files)) {
        const data = new FormData(); data.append('role', uploadRole); data.append('file', file);
        const material = await api<Material>(`/conversations/${current.id}/materials`, { method: 'POST', body: data, signal: AbortSignal.timeout(90_000) });
        if (projectRef.current === current.projectId) setMaterials(items => [...items.filter(item => item.id !== material.id), material]);
      }
      await refreshConversation(current.id); setTab('materials'); setRightOpen(true);
    } catch (error) { setError(errorText(error)); }
    finally { requestBusy.current = false; setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function toggleMaterial(id: string) {
    if (running || requestBusy.current || managementBusy.current || uploading || conversation?.archivedAt || project?.archivedAt) return;
    invalidateOptions();
    if(!conversation){setDraftMaterialIds(old=>old.includes(id)?old.filter(value=>value!==id):[...old,id]);return;}
    requestBusy.current = true; setError(''); setPendingMaterial({ id, selected: !conversation?.materialIds.includes(id) });
    try {
      const current = await ensureConversation();
      const ids = current.materialIds.includes(id) ? current.materialIds.filter(value => value !== id) : [...current.materialIds, id];
      const updated = await api<Conversation>(`/conversations/${current.id}/materials`, { method: 'PUT', body: body({ materialIds: ids }) });
      if (activeRef.current === current.id) adoptConversation(updated);
    } catch (error) { setError(errorText(error)); }
    finally { requestBusy.current = false; setPendingMaterial(null); }
  }

  function showArtifact(artifact: Artifact) { setSelectedArtifactId(artifact.id); setTab('artifacts'); setRightOpen(true); }
  async function selectModel(selection:ActiveModelSelection){
    if(modelSelectionBusy.current)return;modelSelectionBusy.current=true;setModelSelecting(true);
    try{adoptModelConnections(await modelConnectionActions().select(selection));}finally{modelSelectionBusy.current=false;setModelSelecting(false);}
  }

  async function collectEvidence(runId: string, evidenceId: string) {
    const targetProject = projectId;
    const evidenceKey = `${runId}:${evidenceId}`;
    const operationKey = `${targetProject}:${evidenceKey}`;
    if (!targetProject || !runId || !evidenceId || collectionBusy.current.has(operationKey)) return;
    collectionBusy.current.add(operationKey); setCollecting(operationKey); setError('');
    try {
      const result = await api<{ item: LibraryItem; created: boolean }>(`/projects/${encodeURIComponent(targetProject)}/library`, { method: 'POST', body: body({ runId, evidenceId }) });
      if (projectRef.current === targetProject) {
        setLibraryRefresh(value => value + 1);
        setCollected({ projectId: targetProject, evidenceKey, text: result.created ? '已收藏到当前课题。' : '文献夹中已有这篇文献，来源已同步。' });
      }
    } catch (cause) { if (projectRef.current === targetProject) setError(errorText(cause)); }
    finally { collectionBusy.current.delete(operationKey); setCollecting(value => value === operationKey ? '' : value); }
  }

  const archivedSelection=Boolean(conversation?.archivedAt||project?.archivedAt);
  const hasContent = Boolean(conversation?.messages.length);
  const paperLocation = paperNavigation.location;
  const paperProject = paperLocation && projects.find(item => item.id === paperLocation.projectId);
  const paperChat = paperLocation && conversations.find(item => item.projectId === paperLocation.projectId && item.id === paperLocation.conversationId);
  return <><main hidden={Boolean(paperLocation)} className={`workspace ${rightOpen ? 'with-inspector' : ''}`}>
    {leftOpen && <button className="mobile-scrim" aria-label="关闭对话侧栏" onClick={() => setLeftOpen(false)} />}
    <aside className={`sidebar ${leftOpen ? 'open' : ''}`} aria-label="课题与对话">
      <div className="brand"><button className="brand-home" aria-label="智萃科研首页" onClick={()=>void newConversation()} disabled={sending||uploading}><div className="brand-symbol"><Leaf size={24} strokeWidth={1.5} /></div><div><strong>智萃科研</strong><span>ZHICUI RESEARCH</span></div></button><button className="icon-button mobile-close" aria-label="收起对话侧栏" onClick={() => setLeftOpen(false)}><PanelLeftClose size={17} /></button></div>
      <WorkspaceTree index={{projects,conversations,sections}} activeId={conversation?.id??''} disabled={sending||uploading} onHome={()=>void newConversation()} onNew={id=>void newConversation(id)} onSelect={id=>void selectConversation(id)} onPapers={id => { setLeftOpen(false); paperNavigation.open(id); }} onSaved={()=>{setSavedOpen(true);setLeftOpen(false);}} onBeforeMutation={target=>{managementBusy.current=true;setManaging(true);++indexVersion.current;const affected=target.kind==='conversation'?activeRef.current===target.id:(conversations.find(item=>item.id===activeRef.current)?.projectId??projectRef.current)===target.id;if(affected){if(activeRef.current&&!conversation)interruptedSelection.current={id:activeRef.current,navigationVersion:navigationVersion.current};++selectionVersion.current;setLoading(false);}return navigationVersion.current;}} onAfterMutation={()=>{managementBusy.current=false;setManaging(false);const interrupted=interruptedSelection.current;interruptedSelection.current=undefined;if(interrupted&&activeRef.current===interrupted.id&&navigationVersion.current===interrupted.navigationVersion)void selectConversation(interrupted.id);}} onChanged={workspaceChanged}/>
      <button className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /><span>模型与接入</span><span className={`status-dot ${selectedModelVerified(modelConnections) ? 'green' : 'muted-dot'}`} /></button>
      <div className="sidebar-footer"><span>本地研究工作台</span><span>01</span></div>
    </aside>

    <section className="conversation-pane" aria-label="当前对话">
      <header className="conversation-header"><div className="header-path"><button className="icon-button menu-button" onClick={() => setLeftOpen(true)} aria-label="展开对话侧栏"><Menu size={19} /></button><FolderOpen size={15} /><span className="path-project">{project?.name || '首页'}</span><ChevronRight size={13} /><span className="path-chat">{conversation?.title || '新的研究对话'}</span></div>
        <div className="header-actions">
          {projectId && <button className="open-paper-library" onClick={() => paperNavigation.open(projectId, conversation?.id)}
            disabled={sending || uploading || loading || managing}><BookOpen size={15} />论文库</button>}
          <span className="local-label"><span className="status-dot green" />{conversation?conversation.archivedAt?'已归档':'本地保存':'发送后保存'}</span><button className="icon-button" onClick={() => setRightOpen(value => !value)} aria-label={rightOpen ? '收起材料与成果' : '展开材料与成果'}>{rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div></header>

      <div className="conversation-scroll" ref={scroll} onScroll={() => {
        const element = scroll.current;
        if (element) { followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160; setShowScroll(!followScroll.current); }
      }}>
        {loading ? <div className="workspace-loading"><LoaderCircle size={20} className="spin" /><span>正在打开研究空间…</span></div> : !hasContent ? <div className="welcome">
          <h1>今天想完成什么？</h1>
          <p>{project?`在「${project.name}」开始新研究。`:'写下研究需求，有材料也可以一起附上。'}<br/><small>新聊天在发送后保存；从左侧项目打开历史对话。</small></p>
          <div className="welcome-prompts"><span>可以这样开始</span><button onClick={() => { setDraft('我想研究生成式 AI 如何影响教师备课，请先完成一篇主题综述，到综述为止。'); composer.current?.focus(); }}>“我有一个方向，先帮我完成综述。”<ArrowUpRight size={15} /></button><button onClick={() => { setDraft('这是我已有的研究材料，请沿用其中有效结果，只完善讨论部分，并保留证据和解释边界。'); composer.current?.focus(); }}>“材料已经齐了，只完善讨论部分。”<ArrowUpRight size={15} /></button></div>
        </div> : <div className="message-list">
          <div className="conversation-date">{new Date(conversation!.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} · 研究对话</div>
          {conversation!.messages.map(message => {
            const run = conversation!.runs.find(item => item.id === message.runId);
            const resultArtifacts = conversation!.artifacts.filter(item => item.runId === message.runId);
            return <article className={`message ${message.role}`} key={message.id}>
              {message.role === 'assistant' && <div className="assistant-mark"><Leaf size={16} /></div>}
              <div className="message-content"><div className="message-meta"><span>{message.role === 'user' ? '你' : '智萃'}</span><time dateTime={message.createdAt}>{time(message.createdAt)}</time>{message.kind === 'plan' && <em>工作安排</em>}<CopyMessageButton text={messageCopyText(message,run)}/></div>
                {message.kind === 'outline' && run?.outline ? <ArgumentCard run={run} /> : <Markdown text={message.content} sources={sourceLinks} preferredRunId={run?.id} />}
                {message.kind === 'result' && resultArtifacts.length > 0 && <div className="artifact-links">{resultArtifacts.map(artifact => <button key={artifact.id} onClick={() => showArtifact(artifact)}><FileCheck2 size={20} /><span><strong>{artifact.title}</strong><small>{artifact.status === 'limited' ? '已生成 · 有使用说明' : '成果已生成'} · {artifact.formats.map(format => format.toUpperCase()).join(' / ')}</small></span><ArrowUpRight size={17} /></button>)}</div>}
              </div>
            </article>;
          })}
          {latestRun?.outline && !conversation!.messages.some(message => message.kind === 'outline' && message.runId === latestRun.id) && <div className="standalone-outline"><ArgumentCard run={latestRun} /></div>}
          {latestRun && <div className={`run-status ${latestRun.status}`} aria-live="polite">
            {taskContext?.supplements.length ? <div className="task-continuation-note"><strong>本轮补充已接收</strong><span>继续围绕原研究目标处理</span><details><summary>查看原目标与本轮补充</summary><p><b>原目标：</b>{taskContext.rootPrompt}</p><p><b>本轮补充：</b>{taskContext.supplements.at(-1)}</p></details></div> : null}
            {running && pollWarning && <p>暂时无法同步运行状态，正在重新连接。后台任务可能仍在进行。</p>}
            <ResearchProgress run={latestRun} runs={conversation!.runs} artifacts={conversation!.artifacts} onArtifact={showArtifact} />
            <RunContinuation run={latestRun} runs={conversation!.runs} hasDraft={Boolean(draft.trim())} hasChanges={hasMethodChanges||hasMaterialChanges} disabled={sending||modelSelecting} onResume={() => void runAction('resume')} showAction={false}/>
          </div>}
        </div>}
        <div ref={bottom} />
      </div>

      <div className="composer-wrap">
        {archivedSelection&&<p className="notice">此对话或项目已归档。请从左侧菜单恢复后继续研究。</p>}
        {showScroll && <button className="scroll-bottom icon-button" aria-label="回到最新消息" onClick={() => { followScroll.current = true; bottom.current?.scrollIntoView({ behavior: 'smooth' }); }}><ArrowDown size={17} /></button>}
        {latestRun&&<RunStageStatus run={latestRun} runs={conversation!.runs} hasDraft={Boolean(draft.trim())} hasChanges={hasMethodChanges||hasMaterialChanges} disabled={managing||sending||modelSelecting||uploading||loading} onResume={()=>void runAction('resume')}/>}
        {error && <div className="notice error composer-error" role="alert"><span>{error}</span><button className="icon-button small" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
        <div className="composer-box">
          {Boolean(conversation?.materialIds.length) && <div className="attached-summary"><Paperclip size={12} /><button onClick={() => { setTab('materials'); setRightOpen(true); }}>{conversation!.materialIds.length} 份材料已用于此对话</button></div>}
          {latestRun && <div className="composer-intent"><select aria-label="消息用途" value={taskIntent} onChange={event => {invalidateOptions();setTaskIntent(event.target.value as 'continue' | 'new');}} disabled={sending || loading}><option value="continue">补充当前任务</option><option value="new" disabled={taskActive}>单独提问</option></select><span>{continuing ? '保留原目标与要求' : '按本条消息开始独立任务'}</span></div>}
          <textarea ref={composer} aria-label="发送研究需求" value={draft} onChange={event => setDraft(event.target.value)} placeholder={continuing ? (latestRun && awaitingWritingOutline(latestRun) ? '补充写作提纲的调整意见，或审校通过后继续…' : '补充当前研究的要求，原目标与已有要求会保留…') : '描述你的问题，以及这次想交付的成果…'} rows={2} disabled={loading||archivedSelection}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="composer-toolbar"><div className="composer-tools"><button className="icon-button composer-upload" title="附上研究材料" aria-label="上传材料" onClick={() => fileInput.current?.click()} disabled={managing || archivedSelection || uploading || sending || running || loading}>{uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}<span>添加材料</span></button><ModelPicker state={modelConnections} providers={providers} run={latestRun} disabled={managing||sending||loading} onSelect={selectModel} onManage={()=>setSettingsOpen(true)}/></div>
            <div className="composer-actions">{taskActive && <button className="stop-button" onClick={() => void runAction('cancel')} disabled={sending || uploading || loading} aria-label="停止当前任务"><Square size={13} fill="currentColor" />停止</button>}<button className={`send-button${continuing ? ' supplement-button' : ''}`} aria-label={continuing ? '补充要求' : '发送消息'} disabled={managing || archivedSelection || !draft.trim() || sending || modelSelecting || uploading || loading || (taskIntent === 'new' && taskActive)} onClick={() => void send()}>{sending ? <LoaderCircle size={18} className="spin" /> : <><span>{continuing ? '补充要求' : '发送'}</span><ArrowUp size={17} /></>}</button></div></div>
        </div>
        <div className="composer-caption"><span>{running ? 'Enter 提交补充 · 研究在后台运行 · 切换对话后仍会继续' : 'Enter 发送 · Shift + Enter 换行'}</span></div>
      </div>
    </section>

    {rightOpen && <aside className="inspector" aria-label="材料与成果">
      <header className="inspector-header"><div role="tablist" aria-label="研究空间"><button role="tab" aria-selected={tab === 'materials'} onClick={() => setTab('materials')}>材料<span>{materials.length}</span></button><button role="tab" aria-selected={tab === 'library'} onClick={() => setTab('library')}>文献夹</button><button role="tab" aria-selected={tab === 'artifacts'} onClick={() => setTab('artifacts')}>成果<span>{conversation?.artifacts.length || 0}</span></button></div><button className="icon-button inspector-close" aria-label="关闭材料与成果" onClick={() => setRightOpen(false)}><X size={16} /></button></header>
      <div className="inspector-scroll" role="tabpanel" aria-label={tab === 'materials' ? '研究材料' : tab === 'library' ? '文献夹' : '研究成果'}>
        {tab === 'library' ? <LibraryPanel projectId={projectId} refreshKey={libraryRefresh} drafts={libraryDrafts.current} onChanged={() => setLibraryRefresh(value => value + 1)} /> : tab === 'materials' ? <>
          <div className="inspector-intro"><h2>添加研究材料</h2><p>文献、数据、课件或方法要求，都可以放在这里。</p></div>
          <div className="upload-controls"><select aria-label="上传材料用途" value={uploadRole} onChange={event => setUploadRole(event.target.value as Material['role'])} disabled={uploading || running}>{Object.entries(materialLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="secondary-button" onClick={() => fileInput.current?.click()} disabled={managing || archivedSelection || uploading || sending || running}>{uploading ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}添加材料</button></div>
          <p className="file-types">PDF / Word / Markdown / TXT / CSV / JSON</p>
          {draftFiles.length>0&&<div className="draft-attachments"><p>待发送材料 · 发送研究需求后上传并保存</p>{draftFiles.map((entry,i)=><div key={i}><span>{entry.file.name}</span><button aria-label={`移除待上传材料 ${entry.file.name}`} onClick={()=>setDraftFiles(old=>old.filter((_,index)=>index!==i))}>移除</button></div>)}</div>}
          {materials.length ? <div className="material-list">{materials.map(material => <div className={`material-item ${(conversation?.materialIds??draftMaterialIds).includes(material.id) ? 'selected' : ''}`} key={material.id}>
            <input type="checkbox" aria-label={`将 ${material.name} 用于当前对话`} checked={pendingMaterial?.id === material.id ? pendingMaterial.selected : (conversation?.materialIds??draftMaterialIds).includes(material.id) ?? false} onChange={() => void toggleMaterial(material.id)} disabled={managing || archivedSelection || running || sending || uploading || Boolean(pendingMaterial)} />
            <button onClick={() => setSelectedMaterialId(selectedMaterialId === material.id ? '' : material.id)}><FileText size={18} /><span><strong>{material.name}</strong><small>{materialLabels[material.role]} · {bytes(material.size)}</small></span><ChevronRight size={13} /></button>
          </div>)}</div> : <div className="materials-empty"><div className="paper-stack"><FileText size={31} strokeWidth={1} /></div><p>还没有添加材料</p><span>只有研究方向，也可以直接开始。</span></div>}
          {selectedMaterial && <section className="material-preview"><header><strong>{selectedMaterial.name}</strong><button className="icon-button small" aria-label="关闭材料预览" onClick={() => setSelectedMaterialId('')}><X size={14} /></button></header><small>{selectedMaterial.extraction}</small><pre>{selectedMaterial.text}</pre></section>}
          <details className="method-settings"><summary><Settings2 size={15} /><span>本次方法与格式</span><ChevronDown size={13} /></summary><div><p>{continuing ? '未改动的设置沿用当前任务；明确清空或关闭的要求会在发送补充时更新。' : '可直接在消息中说明，也可以在这里补充。仅用于接下来发送的任务。'}</p><label>方法使用方式<select aria-label="方法使用方式" value={displayedMethodMode} onChange={event => { invalidateOptions(); setMethodMode(event.target.value as 'auto' | 'supplement' | 'replace'); setMethodDirty(value => ({ ...value, mode: true })); }} disabled={sending || loading}><option value="auto">自动按对话要求</option><option value="supplement">补充内置方法</option><option value="replace">替换对应内置方法</option></select></label><label>方法要求<textarea value={displayedMethodInstructions} onChange={event => { invalidateOptions(); setMethodInstructions(event.target.value); setMethodDirty(value => ({ ...value, instructions: true })); }} rows={3} placeholder="例如：按导师提供的论证结构组织讨论" disabled={sending || loading} /></label><label>格式要求<textarea value={displayedFormatInstructions} onChange={event => { invalidateOptions(); setFormatInstructions(event.target.value); setMethodDirty(value => ({ ...value, format: true })); }} rows={2} placeholder="期刊、课程、篇幅或引用格式" disabled={sending || loading} /></label><label className="checkbox-label"><input type="checkbox" checked={displayedWaitForConfirmation} onChange={event => { invalidateOptions(); setWaitForConfirmation(event.target.checked); setMethodDirty(value => ({ ...value, confirmation: true })); }} disabled={sending || loading} /><span>写作提纲生成后，先等我审校；通过后自动成稿与复查</span></label><ResearchOptionsConfirmation status={researchOptionsStatus(optionsConfirmation,currentOptionsSnapshot)} onConfirm={()=>setOptionsConfirmation(confirmResearchOptions(currentOptionsSnapshot))} disabled={sending||loading||uploading||Boolean(pendingMaterial)} materialCount={(conversation?.materialIds??draftMaterialIds).length}/></div></details>
          {latestRun?.plan && <TaskRequirements run={latestRun} materials={materials} />}
          {evidenceRun && <details className="evidence-list"><summary><BookOpen size={14} />{evidenceRun.id === latestRun?.id ? '已保存资料' : '此前已保存资料'}<span>{inventory.total} 条</span><ChevronDown size={12} /></summary><p className="evidence-inventory">外部文献 {inventory.papers} 条 · 用户材料或既有成果 {inventory.materials} 条 · 计算结果 {inventory.calculations} 条。资料总数不是论文引用数，列表也保留已排除候选。{evidenceRun.id !== latestRun?.id && '当前查看的是上轮记录，本轮尚未接入。'}</p>{evidenceRun.evidence.length ? evidenceRun.evidence.map(source => {
            const expanded = selectedEvidenceId === source.id;
            const textLabel = source.readScope === 'full_text' ? '正文' : source.readScope === 'abstract' ? '摘要' : '文本';
            return <div className="evidence-item" key={source.id}><strong>{source.title}</strong><div><span>{scopeLabels[source.readScope]}</span><small>{source.id}</small></div><p>{source.location}</p>{['abstract','full_text','metadata'].includes(source.readScope) && <a href={evidenceSourceHref(evidenceRun.id,source.id)} target="_blank" rel="noopener noreferrer">打开原文<ArrowUpRight size={12} /></a>}
              {['abstract','full_text','metadata'].includes(source.readScope) && <button className={libraryStyles.collect} onClick={() => void collectEvidence(evidenceRun.id, source.id)} disabled={!projectId || loading || collecting === `${projectId}:${evidenceRun.id}:${source.id}`}>{collecting === `${projectId}:${evidenceRun.id}:${source.id}` ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}收藏到文献夹</button>}
              {collected?.projectId === projectId && collected.evidenceKey === `${evidenceRun.id}:${source.id}` && <p className={libraryStyles.collectNotice} role="status">{collected.text}<button onClick={() => setTab('library')}>打开文献夹</button></p>}
              {source.text && <button className="evidence-read-button" aria-expanded={expanded} onClick={() => setSelectedEvidenceId(expanded ? '' : source.id)}>{expanded ? '收起' : '阅读'}已获取{textLabel}（{source.text.length} 字符）<ChevronDown size={12} /></button>}
              {expanded && <section className="evidence-text-preview" aria-label={`已获取${textLabel}：${source.title}`}><p>以下是工作台实际保存的完整{textLabel}文本。</p>{source.readScope === 'full_text' && source.abstract && <details><summary>查看检索时的摘要</summary><pre>{source.abstract}</pre></details>}<pre>{source.text}</pre><button onClick={() => downloadEvidenceText(source)}><ArrowDown size={12} />下载已获取文本（非原 PDF）</button></section>}
            </div>;
          }) : <p className="evidence-empty">本轮尚无资料入库；这不表示数据库没有相关研究。具体阶段与停止原因见对话中的进度说明。</p>}</details>}
          <div className="context-note"><CircleHelp size={14} /><p>同一课题的材料可以选用。新对话不会自动读入其他对话的内容。</p></div>
        </> : selectedArtifact ? <>
          <div className="artifact-selector"><label htmlFor="artifact-choice">当前成果</label><select id="artifact-choice" value={selectedArtifact.id} onChange={event => setSelectedArtifactId(event.target.value)}>{conversation!.artifacts.map(artifact => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</select></div>
          <div className="artifact-topline"><span className={`artifact-state ${selectedArtifact.status}`}>{selectedArtifact.status === 'completed' ? '已交付' : '已生成 · 有使用说明'}</span><time>{new Date(selectedArtifact.createdAt).toLocaleDateString('zh-CN')}</time></div>
          <button className="secondary-button save-artifact" onClick={()=>void saveArtifact(selectedArtifact)} disabled={Boolean(savingArtifact)||savedArtifacts.has(selectedArtifact.id)}>{savingArtifact===selectedArtifact.id?'正在保存…':savedArtifacts.has(selectedArtifact.id)?'已保存到项目':'保存到项目'}</button>
          <div className="download-actions">{selectedArtifact.formats.map(format => <a key={format} href={`/api/artifacts/${selectedArtifact.id}/${format}`} download><ArrowDown size={13} />{format.toUpperCase()}</a>)}</div>
          {selectedArtifactRun ? <TaskRequirements run={selectedArtifactRun} materials={materials} artifact={selectedArtifact} /> : <details className="artifact-limitations"><summary>查看采用要求<ChevronDown size={12}/></summary><p>这份成果未保存任务要求记录，未核验期刊符合情况。</p></details>}
          <ArtifactUsageNotes key={selectedArtifact.id} limitations={selectedArtifact.limitations}/>
          <article className="document-preview"><Markdown text={selectedArtifact.markdown} sources={sourceLinks} preferredRunId={selectedArtifact.runId} /></article>
        </> : <div className="artifacts-empty"><div className="artifact-empty-mark"><FileCheck2 size={30} strokeWidth={1.1} /></div><h2>成果会保存在这里</h2><p>完成后即可预览和下载。</p></div>}
      </div>
    </aside>}
    <input type="file" ref={fileInput} hidden multiple accept=".pdf,.docx,.txt,.md,.csv,.tsv,.json" onChange={event => void upload(event.target.files)} />
    {!paperLocation && savedOpen && <SavedWorkspacePanel onClose={()=>setSavedOpen(false)}/>}
    {!paperLocation && settingsOpen && <Settings onClose={() => setSettingsOpen(false)} onConnectionsChanged={adoptModelConnections} />}
  </main>
  {paperLocation && <main className="paper-library-screen">
    <PaperLibrary projectId={paperLocation.projectId} projectName={paperProject?.name ?? '项目'}
      conversationId={paperLocation.conversationId} conversationTitle={paperChat?.title}
      onClose={paperNavigation.close} onCollected={() => setLibraryRefresh(value => value + 1)} />
  </main>}</>;
}
