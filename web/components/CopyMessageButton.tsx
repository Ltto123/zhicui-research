'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,Copy,LoaderCircle} from 'lucide-react';
import {copyMessageText} from '../lib/message-copy';

export function CopyMessageButton({text}:{text:string}){
  const [status,setStatus]=useState<'idle'|'copying'|'copied'|'failed'>('idle'),[pending,setPending]=useState(false);
  const mounted=useRef(true),busy=useRef(false),version=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{version.current++;setStatus('idle');},[text]);
  async function copy(){
    if(busy.current)return;const attempt=version.current;busy.current=true;setPending(true);setStatus('copying');
    try{await copyMessageText(text,navigator.clipboard?.writeText.bind(navigator.clipboard));if(mounted.current&&version.current===attempt)setStatus('copied');}
    catch{if(mounted.current&&version.current===attempt)setStatus('failed');}finally{busy.current=false;if(mounted.current)setPending(false);}
  }
  return <span className="message-copy"><button type="button" title="复制消息正文" aria-label="复制消息" onClick={()=>void copy()} disabled={pending}>{status==='copying'?<LoaderCircle size={13} className="spin"/>:status==='copied'?<Check size={13}/>:<Copy size={13}/>}<span>{status==='copied'?'已复制':'复制'}</span></button><span role="status" className={status==='failed'?'copy-feedback failed':'copy-feedback'}>{status==='failed'?'复制失败，请手动选择正文复制。':status==='copied'?'消息已复制。':''}</span></span>;
}
