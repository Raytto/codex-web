import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Download,LoaderCircle,RotateCw} from 'lucide-react';
import {api,BASE_PATH,type RestoreProgress} from './api';
import './storage-restore-progress.css';

const stages:Record<string,string>={idle:'正在准备',cold:'正在准备',queued:'等待恢复',preparing:'正在准备恢复',converting:'正在整理旧版归档',downloading:'正在下载',verifying:'正在校验文件',installing:'正在恢复到原位置',ready:'已就绪',error:'恢复暂未完成'};
export function useRestoreProgress(id:string,kind:'file'|'conversation',active=true,publicView=false){
  const [progress,setProgress]=useState<RestoreProgress|null>(null);
  useEffect(()=>{
    setProgress(null);if(!active || !id)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const value=await (kind==='file'?api.fileStorageProgress(id,publicView,controller.signal):api.conversationStorageProgress(id,controller.signal));if(!controller.signal.aborted)setProgress(value);}
      catch{/* Keep the last known stage during a transient connection failure. */}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),1500);
    };
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[id,kind,active,publicView]);
  return progress;
}
export function RestoreProgressView({progress,title='正在恢复文件',compact=false,onRetry}:{progress:RestoreProgress|null;title?:string;compact?:boolean;onRetry?:()=>void}){
  const failed=progress?.state==='error',complete=progress?.state==='complete';
  const percent=progress?.percent??null;
  return <div className={`storage-progress${compact?' compact':''}${failed?' failed':''}`} role={failed?'alert':'status'} aria-live="polite" aria-busy={!failed&&!complete}>
    <div className="storage-progress-heading">{!failed&&!complete&&<LoaderCircle className="spin" size={compact?14:19} aria-hidden="true"/>}<span>{title}</span>{percent!==null&&!failed&&<span className="storage-progress-percent">{progress?.estimated&&!complete?'约 ':''}{percent}%</span>}</div>
    {!failed&&<div className={`storage-progress-track${percent===null?' indeterminate':''}`} role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} aria-valuetext={percent===null?(stages[progress?.stage??'preparing']??'正在恢复'):undefined}><i style={percent===null?undefined:{width:`${percent}%`}}/></div>}
    <div className="storage-progress-detail"><span>{failed?(progress.error||'恢复暂未完成，请重试。'):(stages[progress?.stage??'preparing']??'正在恢复')}</span>{failed&&onRetry&&<button type="button" onClick={onRetry}><RotateCw size={14}/>重试</button>}</div>
  </div>;
}
export function FileRestoreStatus({fileId,publicView=false,compact=false}:{fileId:string;publicView?:boolean;compact?:boolean}){
  const progress=useRestoreProgress(fileId,'file',true,publicView);
  return <RestoreProgressView progress={progress} compact={compact}/>;
}
export function ConversationRestoreStatus({conversationId,compact=false}:{conversationId:string;compact?:boolean}){
  const progress=useRestoreProgress(conversationId,'conversation');
  const [error,setError]=useState('');
  async function retry(){setError('');try{await api.restoreConversationStorage(conversationId);}catch{setError('暂时无法连接，请稍后重试。');}}
  return <div className={compact?'conversation-storage-banner':'conversation-storage-panel'}><RestoreProgressView progress={error?{state:'error',stage:'error',percent:null,estimated:false,updatedAt:0,error}:progress} title="正在恢复会话所需内容" onRetry={()=>void retry()}/>{!compact&&<p>恢复完成后会自动继续。</p>}</div>;
}
export function RestoreDownloadButton({file,children,className='',title='下载原文件'}:{file:{id:string;original_name:string};children?:ReactNode;className?:string;title?:string}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const controller=useRef<AbortController|null>(null);
  const progress=useRestoreProgress(file.id,'file',busy);
  useEffect(()=>()=>controller.current?.abort(),[file.id]);
  async function download(){
    if(busy)return;const current=new AbortController();controller.current=current;setBusy(true);setError('');
    try{
      const result=await api.restoreSharedFile(file.id,current.signal);
      if(result.restoring){
        const deadline=Date.now()+10*60_000;
        for(;;){
          const state=await api.fileStorageProgress(file.id,false,current.signal);
          if(state.state==='complete')break;
          if(state.state==='error')throw new Error(state.error||'恢复暂未完成，请重试。');
          if(Date.now()>deadline)throw new Error('文件仍在恢复，稍后点击下载即可继续。');
          await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};const timer=setTimeout(()=>{current.signal.removeEventListener('abort',abort);resolve();},1500);current.signal.addEventListener('abort',abort,{once:true});});
        }
      }
      if(current.signal.aborted)return;
      const anchor=document.createElement('a');anchor.href=`${BASE_PATH}/api/files/${encodeURIComponent(file.id)}?download=1`;anchor.download=file.original_name;anchor.hidden=true;document.body.append(anchor);anchor.click();anchor.remove();
    }catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:'下载准备失败，请重试。');}
    finally{if(!current.signal.aborted)setBusy(false);}
  }
  return <span className="storage-download"><button type="button" className={className} title={title} aria-label={title} disabled={busy} onClick={()=>void download()}>{busy?<LoaderCircle className="spin" size={16}/>:children??<Download size={16}/>}</button>{busy&&<RestoreProgressView compact progress={progress} title="准备下载"/>}{error&&<span className="storage-download-error" role="alert">{error}<button type="button" onClick={()=>void download()}>重试</button></span>}</span>;
}
