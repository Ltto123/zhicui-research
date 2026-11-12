export interface ResearchOptionsValues {
  methodMode:'auto'|'supplement'|'replace';
  methodInstructions:string;
  formatInstructions:string;
  waitForConfirmation:boolean;
  materialIds:readonly string[];
  taskIntent:'continue'|'new';
}
export interface ResearchOptionsSnapshot {scopeKey:string;editVersion:number;fingerprint:string;}
export interface ResearchOptionsConfirmationState {
  confirmed?:ResearchOptionsSnapshot;
  applied?:{snapshot:ResearchOptionsSnapshot;runId:string};
}
export type ResearchOptionsConfirmationStatus='pending'|'confirmed'|'applied';

// Compare the values actually submitted, without depending on material order.
// editVersion is incremented by each form edit, so edit-and-revert cannot revive
// an earlier confirmation. Scope must identify the current conversation visit.
export function researchOptionsSnapshot(scopeKey:string,editVersion:number,values:ResearchOptionsValues):ResearchOptionsSnapshot {
  return {scopeKey,editVersion,fingerprint:JSON.stringify({methodMode:values.methodMode,methodInstructions:values.methodInstructions.trim(),formatInstructions:values.formatInstructions.trim(),waitForConfirmation:values.waitForConfirmation,materialIds:[...new Set(values.materialIds)].sort(),taskIntent:values.taskIntent})};
}
function matches(a:ResearchOptionsSnapshot|undefined,b:ResearchOptionsSnapshot):boolean {
  return Boolean(a&&a.scopeKey===b.scopeKey&&a.editVersion===b.editVersion&&a.fingerprint===b.fingerprint);
}
export function invalidateResearchOptions():ResearchOptionsConfirmationState {return {};}
export function confirmResearchOptions(current:ResearchOptionsSnapshot):ResearchOptionsConfirmationState {
  return {confirmed:{...current}};
}
export function researchOptionsStatus(state:ResearchOptionsConfirmationState,current:ResearchOptionsSnapshot):ResearchOptionsConfirmationStatus {
  return matches(state.applied?.snapshot,current)?'applied':matches(state.confirmed,current)?'confirmed':'pending';
}
/** Call only after a successful server response, with the captured submitted
 * snapshot and the current form. A failed request must leave state unchanged. */
export function acceptResearchOptions(state:ResearchOptionsConfirmationState,submitted:ResearchOptionsSnapshot,current:ResearchOptionsSnapshot,runId:string):ResearchOptionsConfirmationState {
  if(!runId.trim()||!matches(submitted,current))return state;
  return {confirmed:{...submitted},applied:{snapshot:{...submitted},runId}};
}
/** Only the explicit new-conversation creation path may transfer a snapshot.
 * The caller also checks its conversation selection/creation request token. */
export function rebindResearchOptionsScope(snapshot:ResearchOptionsSnapshot,from:string,to:string,currentEditVersion:number,currentValues:ResearchOptionsValues):ResearchOptionsSnapshot|undefined {
  if(!to||snapshot.scopeKey!==from||!matches(snapshot,researchOptionsSnapshot(from,currentEditVersion,currentValues)))return;
  return {...snapshot,scopeKey:to};
}
