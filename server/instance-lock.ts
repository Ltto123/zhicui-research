import fs from 'node:fs';
import path from 'node:path';
/** Prevent a duplicate launch from marking the first server's live runs interrupted. */
export function acquireInstanceLock(root:string):()=>void {
  fs.mkdirSync(root,{recursive:true});const file=path.join(root,'server.lock');
  // Serialize stale-lock recovery. A second contender must not unlink a newly
  // acquired lock based on a stale PID read before the first contender ran.
  const recovery=file+'.recovery';let recoveryFd:number;
  try{recoveryFd=fs.openSync(recovery,'wx',0o600);}catch{throw new Error('另一个服务正在获取资料库锁；请稍后重试。若启动异常退出，请确认没有服务运行后移除 .data/server.lock.recovery');}
  try{
    if(fs.existsSync(file)){
      let pid:number;try{pid=JSON.parse(fs.readFileSync(file,'utf8')).pid;}catch{throw new Error('运行锁损坏，请先确认没有智萃服务运行，再移除 .data/server.lock');}
      if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('运行锁包含无效进程编号');
      let alive=true;try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
      if(alive)throw new Error(`资料库已由本机进程 ${pid} 使用，请打开现有窗口或先停止该服务。`);
      fs.unlinkSync(file);
    }
    const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }finally{fs.closeSync(recoveryFd);fs.unlinkSync(recovery);}
  let released=false;return()=>{if(released)return;released=true;try{const current=JSON.parse(fs.readFileSync(file,'utf8'));if(current.pid===process.pid)fs.unlinkSync(file);}catch{}};
}
