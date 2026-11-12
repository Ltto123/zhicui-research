export type ProviderKind = 'api' | 'codex' | 'claude';
export interface ModelConfig { kind: ProviderKind; baseUrl: string; model: string; apiKey?: string; protocol: 'openai' | 'anthropic'; connectionId?: string; connectionName?: string; }
export interface ModelConnectionVerification { model: string; status: 'verified' | 'failed'; checkedAt: string; detail: string; }
export interface PublicModelConnection { id: string; name: string; baseUrl: string; protocol: 'openai' | 'anthropic'; models: string[]; hasApiKey: boolean; verification: ModelConnectionVerification[]; }
export type ActiveModelSelection = {kind: 'api'; connectionId: string; model: string} | {kind: 'codex' | 'claude'; model: string};
export interface ModelConnectionsState { connections: PublicModelConnection[]; active: ActiveModelSelection | null; }
export interface PublicSettings { kind: ProviderKind; baseUrl: string; model: string; protocol: 'openai' | 'anthropic'; hasApiKey: boolean; connectionId?: string; connectionName?: string; verification?: ModelConnectionVerification; }
export interface ProviderStatus { kind: ProviderKind; available: boolean; detail: string; }
export type RunStatus = 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'limited' | 'failed' | 'cancelled' | 'interrupted';
export interface Project { id: string; name: string; createdAt: string; updatedAt?:string; pinned?:boolean; archivedAt?:string; sectionId?:string; description?:string; removedAt?:string; isDefault?:boolean; }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; runId?: string; kind?: 'plan' | 'outline' | 'result' | 'notice'; }
export interface Material { id: string; projectId: string; name: string; mime: string; size: number; text: string; sha256: string; createdAt: string; role: 'evidence' | 'method' | 'format'; extraction: string; }
export interface Conversation { id: string; projectId: string; title: string; createdAt: string; updatedAt: string; materialIds: string[]; messages: Message[]; runs: Run[]; artifacts: Artifact[]; pinned?:boolean; archivedAt?:string; unread?:boolean; sectionId?:string; forkedFrom?:string; }
export interface MethodSelection { mode: 'supplement' | 'replace'; cardIds: string[]; instructions: string; summary: string; formatInstructions: string; profileId?: 'education-review'; }
export interface TaskPlan { question: string; deliverable: string; title: string; taskType: 'review' | 'proposal' | 'report' | 'paper' | 'analysis' | 'local' | 'format'; methods: MethodSelection; methodAction?: 'inherit' | 'modify' | 'new'; searchQueries: string[]; minimumReferences?: number; evidenceRequirement?: 'abstract_or_full_text' | 'full_text'; needsCalculation: boolean; waitForConfirmation: boolean; workPlan: string[]; }
export interface Evidence { id: string; title: string; url?: string; doi?: string; authors?: string; year?: string; journal?: string; publicationType?: string; abstract?: string; fullTextUrls?: string[]; sourceDocument?: {fileName:string;mimeType:'application/pdf';sha256:string}; text: string; location: string; readScope: 'full_text' | 'abstract' | 'metadata' | 'user_material' | 'computed'; materialId?: string; retrievedAt: string; }
export interface ArgumentRow { section: string; purpose: string; claim: string; evidenceIds: string[]; locations: string[]; reasoning: string; limits: string; support: 'supported' | 'partial' | 'unsupported' | 'contradicted' | 'unclear'; }
export interface ArgumentOutline { question: string; deliverable: string; rows: ArgumentRow[]; gaps: string[]; }
export interface ReviewIssue { severity: 'error' | 'warning'; location: string; issue: string; suggestion: string; }
export interface RevisionProof { evidenceId:string;start:number;end:number;quote:string; }
export interface RevisionInput { issues:ReviewIssue[];proofs?:RevisionProof[]; }
export interface RevisionRecord { baseRunId:string;issues:ReviewIssue[];proofs:RevisionProof[];phase:'pending'|'draft_saved'|'applied';createdAt:string; }
export interface ReviewResult { issues: ReviewIssue[]; checks: string[]; limitations: string[]; }
export interface RunEvent { seq: number; type: 'progress' | 'outline' | 'review' | 'artifact' | 'status'; message: string; createdAt: string; }
export interface RetrievalDiagnostic { source: string; query: string; url: string; status: 'ok' | 'error' | 'timeout' | 'not_attempted'; returned: number; error?: string; retrievedAt: string; }
export interface RetrievalRecord { discoveredCount?:number; rawReturnedCount?:number; pendingEvidence?:Evidence[]; version?: number; completedAt?: string; evidenceHash?: string; attemptedAt: string; queries: string[]; minimumReferences: number; targetCount: number; retrievedCount: number; usableCount: number; warnings: string[]; diagnostics?: RetrievalDiagnostic[]; }
export interface ScreeningRecord { inputHash?: string; includedIds: string[]; includedReasons?: Record<string,string>; excluded: {id:string;reason:string}[]; screenedCount: number; fullTextIds?: string[]; fullTextReasons?: Record<string,string>; }
export interface FullTextRetrievalRecord { inputHash:string; completedAt:string; requestedIds:string[]; acquiredIds:string[]; warnings:string[]; diagnostics?:RetrievalDiagnostic[]; }
export interface RetrievalExpansionRecord { stage:'searching'|'screening'|'fetching'|'complete'|'failed'; discovery?:'pending'|'network'; attemptedAt:string; completedAt?:string; gapBefore:number; targetCount:number; retrieval?:RetrievalRecord; candidateIds:string[]; requestedIds:string[]; acquiredIds:string[]; reusedIds:string[]; warnings:string[]; diagnostics?:RetrievalDiagnostic[]; error?:string; }
export interface TaskContext { rootRunId: string; rootPrompt: string; supplements: string[]; parentRunId?: string; }
export interface ModelUsage { input?:number;output?:number;cacheRead?:number;cacheWrite?:number;total?:number; }
export interface ModelExecution { id:string;startedAt:string;callLimit:number;calls:{index:number;stage:string;usage:ModelUsage[]}[]; }
export interface RunModelUse { executionId: string; provider: ProviderKind; model: string; connectionId?: string; connectionName?: string; startedAt: string; calls: number; }
// Public execution identity only; never persist ModelConfig or credentials here.
export interface Run { connectionId?: string; connectionName?: string; modelHistory?: RunModelUse[]; }
// API-only approval identity. It is derived from the viewed writing state and is never persisted.
export interface Run { confirmationToken?:string; }
// Earlier bounded batches remain auditable when a later manual execution
// consumes more already-discovered candidates. retrievalExpansion is current.
export interface Run { retrievalExpansionHistory?:RetrievalExpansionRecord[]; }
export interface ResearchAgentState { version:1; sessionFile?:string; sessionId?:string; executionId:string; startedAt:string; calls:number; callLimit:number; turnIntent?:'continue'|'update'|'new'; checkpointRunId?:string; checkpointPrompt?:string; lastAction?:string; nextAction?:string; pauseReason?:string; steps:{action:string;status:'running'|'ok'|'error';message:string;at:string}[]; }
// Host-authored provenance: neither field is accepted from model tool arguments.
export interface ResearchAgentState { acceptedPreparation?:{mode:'continue'|'writing_update'|'research_update'|'new_task';requestHash:string;executionId:string}; }
export interface Run { referenceRequirement?:{minimumReferences:number;source:'user_prompt'|'user_options'|'user_material'|'unspecified';sourceId?:string;requestHash:string}; }
// Unlike transient optionOverrides, this user-authored source survives resume.
export interface Run { requirementOptions?:Pick<RunOptions,'methodInstructions'|'formatInstructions'>; }
export interface TaskPlan { requiresResearchEvidence?:boolean; }
export interface Run { agent?:ResearchAgentState; screeningCheckpoint?:import('../server/screening').ScreeningCheckpoint; writingReview?:{version:1;inputHash:string;reviewHash:string;reviewedAt:string;readerPolicyVersion?:1}; writingOutline?:{version:1;draftHash:string}; }
export interface FormatGuideline {id:string;url:string;finalUrl:string;title:string;text:string;retrievedAt:string;contentHash:string;sourceLabel:string;sourceKind:'web';identityStatus:'unverified';providedByUser?:boolean;}
export interface Run {formatGuidelines?:FormatGuideline[];}
export interface Run {
 pendingWritingTarget?:{previousDraftHash:string};
 writingReviewCheckpoint?:{version:1;contextHash:string;draftHash:string;draft:string;review:ReviewResult;reviewHash:string;reviewedAt:string;readerPolicyVersion?:1};
 writingPatch?:{version:1;baseDraftHash:string;edits:{before:string;after:string}[]};
 writingCitations?:{version:1;draftHash:string;sections:{heading:string;evidenceIds:string[]}[]};
}
export interface Run { id: string; conversationId: string; prompt: string; taskContext?: TaskContext; researchCheckpoint?:{sourceRunId:string;sourcePrompt:string;kind:'same_research'|'evidence_only'}; failure?:{stage:string;message:string}; progress?:{readingCompleteCount:number;writingReadyCount:number}; revision?:RevisionRecord; modelExecution?:ModelExecution; status: RunStatus; stage: string; createdAt: string; updatedAt: string; model: string; provider: ProviderKind; materialIds: string[]; events: RunEvent[]; plan?: TaskPlan; outline?: ArgumentOutline; outlineConfirmed?: boolean; evidence: Evidence[]; retrieval?: RetrievalRecord; screening?: ScreeningRecord; fullTextRetrieval?: FullTextRetrievalRecord; retrievalExpansion?:RetrievalExpansionRecord; reading?: import('../server/reading').ReadingRecord; review?: ReviewResult; draft?: string; methodText?: string; error?: string; }
export interface Artifact { id: string; runId: string; title: string; markdown: string; createdAt: string; status: 'completed' | 'limited'; formats: ('md' | 'html' | 'docx' | 'pdf')[]; limitations: string[]; }
// A snapshot of the settings used for this artifact, never inferred for older files.
export interface Artifact { format?: import('./export-format').ExportFormatProfile; }
export interface Run { formatResolution?: Awaited<ReturnType<typeof import('../server/format-resolution').resolveFormatRequirements>>; }
export interface Run { formatReview?: {inputHash:string;checks:{index:number;status:'met'|'unmet'|'unverifiable';quote:string;detail:string}[];issues:ReviewIssue[];checkedAt:string}; }
export interface GenerateOptions { system: string; prompt: string; signal: AbortSignal; sessionDir: string; timeoutMs?: number; disableTransientRetries?:boolean; onUsage?:(usage:ModelUsage)=>void; onProgress?: (message: string) => void; }
export interface ModelProvider { generate(options: GenerateOptions): Promise<string>; }
export interface RunOptions { materialIds?: string[]; methodMode?: 'auto' | 'supplement' | 'replace'; methodInstructions?: string; formatInstructions?: string; waitForConfirmation?: boolean; taskIntent?: 'continue' | 'new'; }
