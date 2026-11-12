export interface EvidenceLinkSource {runId:string;id:string;doi?:string;url?:string;fullTextUrls?:string[];}
function doiFrom(value:string):string|undefined{
  try{const url=new URL(value);if(!['doi.org','dx.doi.org'].includes(url.hostname.toLowerCase())||!['https:','http:'].includes(url.protocol)||url.username||url.password)return;const doi=decodeURIComponent(url.pathname.slice(1));return /^10\.\d{4,9}\/\S+$/.test(doi)?doi.toLowerCase():undefined;}catch{return;}
}
function urlKey(value:string|undefined):string|undefined{
  if(!value)return;
  try{
    const url=new URL(value);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;
    // Bibliography Markdown escapes parentheses. Normalize those and RFC
    // unreserved characters, but keep encoded path/query separators distinct.
    return url.href.replace(/[()]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase()).replace(/%[\da-f]{2}/gi,escape=>{
      const character=String.fromCharCode(parseInt(escape.slice(1),16));
      return /^[a-z\d._~-]$/i.test(character)?character:escape.toUpperCase();
    });
  }catch{return;}
}
export function evidenceSourceHref(runId:string,evidenceId:string):string{return `/source?runId=${encodeURIComponent(runId)}&evidenceId=${encodeURIComponent(evidenceId)}`;}
export function sourceHref(href:string,sources:EvidenceLinkSource[]=[],preferredRunId?:string):string{
  const doi=doiFrom(href),key=urlKey(href);
  const matchesUrl=(value:string|undefined)=>value===href||Boolean(key&&urlKey(value)===key);
  const matching=sources.filter(source=>(doi&&source.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase()===doi)||matchesUrl(source.url)||source.fullTextUrls?.some(matchesUrl));
  const source=matching.find(entry=>entry.runId===preferredRunId)??matching[0];
  if(source)return evidenceSourceHref(source.runId,source.id);
  return doi?`/source?doi=${encodeURIComponent(doi)}`:href;
}
