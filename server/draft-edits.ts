export interface DraftEdit {before:string;after:string;}

/** Locate every edit in the same original snapshot, then apply from left to
 * right. No replacement can make another target appear or disappear. */
export function applyDraftEdits(draft:string,edits:DraftEdit[]):string{
 if(!Array.isArray(edits)||edits.length<1||edits.length>20)throw new Error('局部修订必须包含1–20处精确替换');
 const located=edits.map(edit=>{
  if(!edit||typeof edit.before!=='string'||!edit.before.length||edit.before.length>12000||typeof edit.after!=='string'||edit.after.length>24000)throw new Error('局部替换内容无效或超过单处长度上限');
  const start=draft.indexOf(edit.before);
  if(start<0)throw new Error('待替换原文已不存在，请重新读取当前稿件定位');
  if(draft.indexOf(edit.before,start+1)>=0)throw new Error('待替换原文不唯一，请包含足够上下文精确定位');
  return {...edit,start,end:start+edit.before.length};
 }).sort((a,b)=>a.start-b.start);
 for(let i=1;i<located.length;i++)if(located[i].start<located[i-1].end)throw new Error('局部替换范围重叠，未应用任何修改');
 if(located.reduce((sum,edit)=>sum+edit.after.length,0)>160000)throw new Error('本批局部替换内容超过长度上限');
 let cursor=0,result='';for(const edit of located){result+=draft.slice(cursor,edit.start)+edit.after;cursor=edit.end;}return result+draft.slice(cursor);
}
