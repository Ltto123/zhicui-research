import {writingLanguageRequirement} from '../shared/export-format';

/** Check only an explicit whole-manuscript language request. This verifies the
 * predominant script of prose, not translation quality or journal compliance. */
export function checkWritingLanguage(draft:string|undefined,requirement:string):{met:boolean;detail:string}|undefined{
 const language=writingLanguageRequirement(requirement);if(language!=='zh')return;
 const prose=(draft??'').replace(/```[^]*?```/g,'').replace(/\$\$[^]*?\$\$/g,'').replace(/\$[^$\n]+\$/g,'').replace(/`[^`\n]+`/g,'').replace(/\[[^\]\n]+\]\([^)]*\)/g,match=>match.slice(1,match.indexOf(']'))).replace(/https?:\/\/\S+/g,'').replace(/\[(?:E-[\w-]+|E\d+|M\d+)(?:\s*[,，;；]\s*(?:E-[\w-]+|E\d+|M\d+))*\]/g,'');
 const han=(prose.match(/\p{Script=Han}/gu)??[]).length,letters=(prose.match(/\p{L}/gu)??[]).length,other=letters-han;
 const met=han>0&&han>other;
 return {met,detail:`正文可读文字统计：汉字 ${han} 个、其他文字字母 ${other} 个；${met?'正文以汉字为主':'尚不能确认正文以汉字为主'}。此检查不证明翻译质量或专业术语准确性。`};
}
