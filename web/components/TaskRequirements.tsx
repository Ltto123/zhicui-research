import type {Artifact,Material,Run} from '../../shared/types';
import {ChevronDown} from 'lucide-react';
import {validatedExportFormatSettings,type ExportFormatProfile} from '../../shared/export-format';
import styles from './TaskRequirements.module.css';

function sourceHref(value:string):string|undefined{
 try{const url=new URL(value);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{}
}

/** Requirements stay available on demand; the user does not audit each rule. */
export function TaskRequirements({run,materials,artifact}:{run:Run;materials:Material[];artifact?:Artifact}){
 const matches=!artifact||artifact.runId===run.id;
 const methods=matches?run.plan?.methods:undefined;
 const sources=matches?materials.filter(material=>run.materialIds.includes(material.id)&&(material.role==='method'||material.role==='format')):[];
 // A run may acquire more guidelines later. Only its current view shows them;
 // an old artifact must not borrow a newer source as its historic authority.
 const guidelines=matches&&!artifact?(run.formatGuidelines??[]):[];
 let profile:ExportFormatProfile|undefined,formatError='';
 try{if(matches&&artifact?.format){validatedExportFormatSettings(artifact.format);profile=artifact.format;}}
 catch{formatError='格式记录暂不能读取，无法确认该文件的版式。';}
 const settings=profile?.settings;
 const instructions=matches?(artifact?.format?.instructions??methods?.formatInstructions):undefined;
 return <details className={styles.panel} key={`${run.id}:${artifact?.id??'plan'}`}>
  <summary><span>查看采用要求</span><ChevronDown size={12}/></summary>
  <div className={styles.content}>
   {!matches?<p className={styles.muted}>成果与任务记录不匹配，未展示其他任务的要求。</p>:<>
    <section aria-label="本次方法要求">
     <h3>研究方法</h3>
     <p>{methods?.summary||'尚未保存方法摘要。'}</p>
     {methods&&<p className={styles.muted}>{methods.mode==='replace'?'替换相应默认方法':'内置方法与本次补充共同使用'}</p>}
     {methods?.instructions&&<details className={styles.source}><summary>方法要求原文</summary><pre className={styles.text}>{methods.instructions}</pre></details>}
     {run.methodText?<details className={styles.source}><summary>完整采用规则</summary><pre className={styles.text}>{run.methodText}</pre></details>:<p className={styles.muted}>未保存完整方法记录。</p>}
    </section>
    <section aria-label="格式要求与执行情况">
     <h3>格式与期刊</h3>
     {instructions?<details className={styles.source}><summary>格式要求原文</summary><pre className={styles.text}>{instructions}</pre></details>:<p className={styles.muted}>{sources.some(source=>source.role==='format')?'已选用上传的格式规范，原文见下方。':guidelines.length?'已取得网页规范，原文见下方。':'采用项目默认版式。'}</p>}
     {formatError?<p className={styles.muted}>{formatError}</p>:artifact&&!profile?<p className={styles.muted}>历史成果未保存具体版式记录，未核验期刊符合情况。</p>:settings&&<details className={styles.source}>
      <summary>本文件导出设置</summary>
      <dl className={styles.settings}>
       <div><dt>纸张</dt><dd>{settings.pageSize}</dd></div>
       <div><dt>页边距</dt><dd>{`上${settings.marginsMm.top} / 下${settings.marginsMm.bottom} / 左${settings.marginsMm.left} / 右${settings.marginsMm.right} mm`}</dd></div>
       <div><dt>字体</dt><dd>{settings.fontEastAsia} / {settings.fontLatin}</dd></div>
       <div><dt>正文</dt><dd>{settings.bodyPt} 磅 · {settings.lineSpacing} 倍行距</dd></div>
       <div><dt>参考文献</dt><dd>{profile?.bibliographyMode==='preserved'?'保留原文书目':'GB/T 顺序编码'}</dd></div>
      </dl>
      <p className={styles.muted}>这里记录文件的版式设置，不代表已完成期刊全部规范核验。</p>
     </details>}
    </section>
    {sources.length>0&&<section aria-label="所选要求材料原文"><h3>来源材料</h3>{sources.map(source=><details className={styles.source} key={source.id}><summary>{source.name}</summary><p className={styles.muted}>用户提供 · {source.role==='method'?'方法要求':'格式规范'} · {source.extraction}</p><pre className={styles.text}>{source.text||'该材料没有可读取的文本。'}</pre></details>)}</section>}
    {guidelines.length>0&&<section aria-label="网页规范来源"><h3>网页规范来源</h3>{guidelines.map(source=>{
     const href=sourceHref(source.url),validDate=Number.isFinite(Date.parse(source.retrievedAt));
     return <details className={styles.source} key={source.id}><summary>{source.title||source.sourceLabel}</summary><p className={styles.muted}>取得日期：{validDate?<time dateTime={source.retrievedAt}>{new Date(source.retrievedAt).toISOString().slice(0,10)}</time>:'未记录'}</p><p>{href?<a href={href} target="_blank" rel="noreferrer noopener">{source.url}</a>:source.url}</p><pre className={styles.text}>{source.text}</pre></details>;
    })}</section>}
   </>}
  </div>
 </details>;
}

export function ArtifactUsageNotes({limitations}:{limitations:string[]}){
 if(!limitations.length)return null;
 return <details className="artifact-limitations"><summary>使用说明<ChevronDown size={12}/></summary><ul>{limitations.map((limit,index)=><li key={index}>{limit}</li>)}</ul></details>;
}
