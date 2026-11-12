import {createHash} from 'node:crypto';
import type {Run} from '../shared/types';
import {bodyCitationIds,draftBody} from './engine';
import {applyDraftEdits} from './draft-edits';
import {reviewSchema} from './schemas';
import {isDeepStrictEqual} from 'node:util';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const INCREMENTAL_REVIEW_SCOPE='本轮只对局部改动、受影响引用及此前未解决问题作增量复查；未修改内容沿用此前已完成的完整审查，不声称再次核验全文。';
export function writingCitations(draft:string):NonNullable<Run['writingCitations']>{
 const sections:{heading:string;evidenceIds:string[]}[]=[];let heading='正文',lines:string[]=[];
 const flush=()=>{const evidenceIds=[...bodyCitationIds(lines.join('\n'))];if(lines.length)sections.push({heading,evidenceIds});lines=[];};
 for(const line of draftBody(draft).body.split('\n')){const match=/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);if(match){flush();heading=match[1];}lines.push(line);}flush();
 return {version:1,draftHash:hash(draft),sections};
}
function changedCharacters(before:string,after:string){let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;let left=before.length,right=after.length;while(left>start&&right>start&&before[left-1]===after[right-1]){left--;right--;}return Math.max(left-start,right-start);}
function paragraph(text:string,start:number,end:number){const from=text.lastIndexOf('\n\n',Math.max(0,start-1)),to=text.indexOf('\n\n',end);return text.slice(from<0?0:from+2,to<0?text.length:to);}
/** Fail closed to a full review when the local-edit provenance or scientific
 * inputs differ. No raw source or draft is truncated to fit this projection. */
export function incrementalReviewContext(run:Pick<Run,'draft'|'writingReviewCheckpoint'|'writingPatch'>,contextHash:string){
 const base=run.writingReviewCheckpoint,patch=run.writingPatch,draft=run.draft;
 if(!base||!patch||typeof draft!=='string'||!draft||typeof base.draft!=='string'||!base.review||typeof base.review!=='object'||base.version!==1||patch.version!==1||base.contextHash!==contextHash||base.draftHash!==hash(base.draft)||base.reviewHash!==hash(base.review)||patch.baseDraftHash!==base.draftHash||!Array.isArray(patch.edits)||!patch.edits.length||patch.edits.length>20)return;
 if(!Array.isArray(base.review.issues)||!Array.isArray(base.review.checks)||!Array.isArray(base.review.limitations))return;
 const parsed=reviewSchema.safeParse(base.review);if(!parsed.success||!isDeepStrictEqual(parsed.data,base.review))return;
 const heading=(text:string)=>text.match(/^\s{0,3}#{1,6}\s+.*$/gm)??[];
 if(JSON.stringify(heading(base.draft))!==JSON.stringify(heading(draft)))return;
 let working=base.draft,changed=0;const changes:{editIndex:number;before:string;after:string;beforeParagraph:string}[]=[],ranges:{start:number;end:number}[]=[];
 try{for(const [editIndex,edit] of patch.edits.entries()){
  const start=working.indexOf(edit.before),end=start+edit.before.length;
  const next=applyDraftEdits(working,[edit]),delta=edit.after.length-edit.before.length;
  changes.push({editIndex,before:edit.before,after:edit.after,beforeParagraph:paragraph(working,start,end)});changed+=changedCharacters(edit.before,edit.after);
  for(const range of ranges){range.start=range.start<=start?range.start:range.start>=end?range.start+delta:start;range.end=range.end<start?range.end:range.end>=end?range.end+delta:start+edit.after.length;}
  ranges.push({start,end:start+edit.after.length});working=next;
 }}catch{return;}
 if(working!==draft||changed>Math.max(1,base.draft.length*.2)||changed>6000)return;
 const currentPassages=[...new Set(ranges.map(range=>paragraph(draft,range.start,range.end)))];
 if(JSON.stringify({changes,currentPassages}).length>50000)return;
 const sourceIds=[...new Set([...changes.flatMap(change=>[...bodyCitationIds(change.beforeParagraph)]),...currentPassages.flatMap(passage=>[...bodyCitationIds(passage)])])];
 return {scope:INCREMENTAL_REVIEW_SCOPE,changes,currentPassages,sourceIds,previousReview:base.review,baselineDraftHash:base.draftHash,currentDraftHash:hash(draft)};
}
