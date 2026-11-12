import type {Artifact,Conversation,Material,Project,RunStatus} from './types';

export interface WorkspaceSection {id:string;name:string;projectId?:string;createdAt:string;}
export interface ConversationSummary {id:string;projectId:string;title:string;createdAt:string;updatedAt:string;pinned?:boolean;archivedAt?:string;unread?:boolean;sectionId?:string;latestStatus?:RunStatus;messageCount:number;artifactCount:number;}
export interface WorkspaceIndex {projects:Project[];conversations:ConversationSummary[];sections:WorkspaceSection[];}
export interface ProjectPatch {name?:string;description?:string;pinned?:boolean;archived?:boolean;sectionId?:string|null;}
export interface ConversationPatch {title?:string;pinned?:boolean;archived?:boolean;unread?:boolean;sectionId?:string|null;}
export interface SavedArtifact {artifact:Artifact;projectId:string;projectName:string;savedAt:string;}
export interface SavedWorkspace {projects:Project[];artifacts:SavedArtifact[];materials:Material[];libraryCounts:{projectId:string;count:number}[];}
export type WorkspaceEntityKind='project'|'conversation';
export interface DeletionPreview {token:string;kind:WorkspaceEntityKind;id:string;name:string;conversations:number;files:number;bytes:number;keptFiles:number;activeRuns:number;warnings:string[];}
export interface DeletionResult {deleted:true;operationId:string;recycledFiles:number;retainedFiles:number;}
export interface ForkResult {conversation:Conversation;}
