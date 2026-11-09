import { BASE_PATH } from "./api";
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Phone,PhoneOff,Mic,MicOff,Pause,Play,VolumeX,MessageSquare,ArrowUpRight} from 'lucide-react';
import {request} from './api';
import {VoiceRecovery} from './voice-recovery';
import {startCallRingback} from './call-ringback';
import './conversation-voice.css';
const post=<T,>(url:string,body:unknown={})=>request<T>(url,{method:'POST',body:JSON.stringify(body)});
type Availability={available:boolean;reason?:string;conversationId?:string;title?:string;activeConversationId?:string|null};
type Owner={id:string;title:string};
type Controls={selectedId:string|null;owner:Owner|null;available:boolean;connected:boolean;state:string;body:boolean;status:string;error:string;busy:boolean;muted:boolean;inputLevel:number;outputLevel:number;execution:string;start:()=>void;takeover:()=>void;resume:()=>void;pause:()=>void;end:()=>void;mute:()=>void;stop:()=>void;chat:()=>void;show:()=>void};
const VoiceContext=createContext<Controls|null>(null);
export function useConversationCallActive(){const v=useContext(VoiceContext);return Boolean(v?.owner&&v.connected);}
export function ConversationCallControl({conversationId,disabled=false}:{conversationId:string|null;disabled?:boolean}){const v=useContext(VoiceContext);if(!v)return null;const current=v.owner?.id===conversationId;
  if(current)return <button type="button" className="mic-button dot-call-button active" aria-label="返回通话" title="返回通话" onClick={v.show}><Phone size={18}/><span className="dot-call-indicator"/></button>;
  if(disabled||!v.available||v.owner||!conversationId)return null;
  return <button type="button" className="mic-button" aria-label="开始通话" title="开始通话" onClick={v.start}><Phone size={18}/></button>;
}
export function ConversationVoiceProvider({conversationId,enabled,recordingBusy,workspaceVisible,onOpen,onActivityChange,children}:{conversationId:string|null;enabled:boolean;recordingBusy:boolean;workspaceVisible:boolean;onOpen:(id:string)=>void;onActivityChange:(active:boolean)=>void;children:ReactNode}){
  const [availability,setAvailability]=useState<Availability|null>(null),[permissionDenied,setPermissionDenied]=useState(false),[callOwner,setCallOwner]=useState<Owner|null>(null),[error,setError]=useState(''),[state,setState]=useState('ended'),[muted,setMuted]=useState(false),[callControls,setCallControls]=useState(false),[busy,setBusy]=useState(false),[inputLevel,setInputLevel]=useState(0),[outputLevel,setOutputLevel]=useState(0),[buffering,setBuffering]=useState(false),[waiting,setWaiting]=useState(false),[execution,setExecution]=useState('');
  const callConversation=useRef<Owner|null>(null),busyRef=useRef(false),permissionCleanup=useRef<(()=>void)|null>(null),ringback=useRef<(()=>void)|null>(null);
    const generation = useRef(0);
    const socket = useRef<WebSocket | null>(null), ctx = useRef<AudioContext | null>(null), stream = useRef<MediaStream | null>(null), capture = useRef<AudioWorkletNode | null>(null), playback = useRef<AudioWorkletNode | null>(null), intentional = useRef(false), retry = useRef(0), reconnect = useRef<ReturnType<typeof setTimeout> | null>(null), alive = useRef(true), activeCall = useRef(false), currentMuted = useRef(false), ready = useRef(false);
    const recoveryState=useRef<VoiceRecovery|null>(null),transportTimer=useRef<ReturnType<typeof setInterval>|null>(null),pendingPing=useRef(0);

    useEffect(()=>{alive.current=true;return()=>{generation.current++;alive.current=false;intentional.current=true;if(reconnect.current)clearTimeout(reconnect.current);send({type:'hangup'});socket.current?.close();cleanupAudio();};},[]);
    useEffect(()=>{if(!enabled){hangup();setAvailability(null);return;}if(!conversationId){setAvailability(null);return;}let disposed=false;const update=()=>request<Availability>(`/conversations/${conversationId}/voice`).then(r=>{if(!disposed)setAvailability(r);}).catch(()=>{if(!disposed)setAvailability(null);});setAvailability(null);void update();const timer=setInterval(()=>void update(),5000);return()=>{disposed=true;clearInterval(timer);};},[conversationId,enabled]);
    useEffect(()=>{let disposed=false;void navigator.permissions?.query({name:'microphone' as PermissionName}).then(p=>{const update=()=>{if(!disposed)setPermissionDenied(p.state==='denied');};update();p.addEventListener('change',update);permissionCleanup.current=()=>p.removeEventListener('change',update);}).catch(()=>{});return()=>{disposed=true;permissionCleanup.current?.();};},[]);

    function clearAudio() { playback.current?.port.postMessage({type:'clear'}); }
    function stopRingback() {ringback.current?.();ringback.current=null;}
    function playRingback() {if(!ringback.current&&ctx.current?.state==='running'){try{ringback.current=startCallRingback(ctx.current);}catch{/* Optional local feedback must not prevent a call. */}}}
    function cleanupAudio() {if(transportTimer.current)clearInterval(transportTimer.current);transportTimer.current=null;recoveryState.current?.disconnected();recoveryState.current=null;stopRingback();setInputLevel(0);setOutputLevel(0);setBuffering(false);ready.current = false; activeCall.current = false; clearAudio(); playback.current?.disconnect(); playback.current=null; capture.current?.disconnect(); capture.current = null; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; void ctx.current?.close(); ctx.current = null; }
    function send(v: unknown) { if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify(v)); }
    function play(delta: string, seq: number, callId:string, recoveryId:number) {
        if(!playback.current)return;
        const bytes=Uint8Array.from(atob(delta),x=>x.charCodeAt(0));if(bytes.length%2)return;
        const view=new DataView(bytes.buffer),samples=new Int16Array(bytes.length/2);
        for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true);
        playback.current.port.postMessage({type:'audio',samples,seq,callId,recoveryId},[samples.buffer]);
    }
    async function connect(takeover = false) {
        const epoch=generation.current;
        const ticket = await post<{
            ticket: string;
            path: string;
        }>(`/conversations/${callConversation.current!.id}/voice`, { takeover });
        if (!alive.current || intentional.current || epoch!==generation.current)
            return;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${ticket.path}`, ['pp-dot', ticket.ticket]);
        socket.current = ws;
        ws.onmessage = e => {
            if(epoch!==generation.current||socket.current!==ws)return;
            const event = JSON.parse(e.data);
            if (event.type === 'status') {
                if(event.recoveryId!==undefined&&event.recoveryId!==recoveryState.current?.recoveryId)return;
                setState(event.state);
                if (event.state === 'reconnecting' || event.state === 'connecting') {
                    ready.current = false;
                    playRingback();
                }
                if (event.state === 'listening' || event.state === 'muted') {
                    stopRingback();
                    activeCall.current = true;
                    retry.current = 0;
                    if (event.callId && recoveryState.current?.bind(event.callId,event.recoveryId)) {
                        ready.current = true;
                        playback.current?.port.postMessage({type:'bind',callId:event.callId,recoveryId:event.recoveryId});
                        send({ type: 'mute', muted: currentMuted.current });
                    }
                }
                if (event.state === 'ended') {
                    stopRingback();
                    ready.current = false;
                    if (!['upstream_disconnected', 'transport_error', 'server_shutdown'].includes(event.reason)) {
                        intentional.current = true;
                        cleanupAudio();
                    }
                }
            }
            if(event.type==='pong'&&event.at===pendingPing.current){
                const delayed=performance.now()-pendingPing.current>1800;pendingPing.current=0;
                if(delayed){recoveryState.current?.freeze();playback.current?.port.postMessage({type:'invalidate',reason:'transport_delay'});}
            }
            if(event.type==='resync_required'){recoveryState.current?.freeze();playback.current?.port.postMessage({type:'invalidate',reason:event.reason});}
            if(event.type==='recovery_ready')recoveryState.current?.recoveryReady(event.recoveryId);
            if (event.type === 'audio'&&recoveryState.current?.accepts(event.callId,event.recoveryId)){
                if(pendingPing.current&&performance.now()-pendingPing.current>1800){recoveryState.current?.freeze();playback.current?.port.postMessage({type:'invalidate',reason:'transport_delay'});return;}
                stopRingback();play(event.delta,event.seq,event.callId,event.recoveryId);
            }
            if(event.type==='execution')setExecution(event.message);
            if (event.type === 'clear_audio' && event.recoveryId===recoveryState.current?.recoveryId)clearAudio();
            if (event.type === 'transcript'&&event.role==='user'&&event.callId===recoveryState.current?.callId&&!recoveryState.current?.blocked)setWaiting(true);
            if (event.type === 'error') {
                stopRingback();
                setError(event.message);
                if (event.code) {
                    intentional.current = true;
                    cleanupAudio();
                }
            }
        };
        ws.onclose = () => { if(epoch!==generation.current||socket.current!==ws)return; ready.current=false; playback.current?.port.postMessage({type:'invalidate',reason:'transport_lost'});recover(); };
        ws.onerror = () => { if (alive.current && epoch===generation.current) {
            stopRingback();setError('通话连接中断，正在核对恢复。'); } };
    }
    function recover() {
        cleanupAudio();
        if(!intentional.current&&alive.current&&retry.current<3){
            const attempt=retry.current++,epoch=generation.current;setState('reconnecting');
            setError('连接中断，旧播报已停止。正在恢复；若刚才的话未被识别，请重复。');
            reconnect.current=setTimeout(()=>{if(epoch===generation.current&&!intentional.current)void start(false,true,true);},1500*2**attempt);
        }else if(alive.current){setState(intentional.current?'ended':'failed');setError('通话连接未能恢复。请重试连接；后台任务保持原状态。');}
    }
    async function start(takeover = false, resume=false, automatic=false) { if (busyRef.current)return;if(recordingBusy){setError('请先结束录音输入，再继续实时通话。');return;} if(!resume&&!takeover){if(!availability?.available||!conversationId)return;currentMuted.current=false;setMuted(false);setExecution('');callConversation.current={id:conversationId,title:availability.title??'当前会话'};setCallOwner(callConversation.current);}if(!callConversation.current)return;onActivityChange(true);busyRef.current=true;generation.current++;const epoch=generation.current;setBusy(true);setCallControls(true); setError(''); intentional.current = false; if(!automatic)retry.current = 0; setState('connecting'); setWaiting(false); try {
        const audio = new AudioContext();
        ctx.current = audio;
        await audio.resume();
        if(epoch!==generation.current || !alive.current || intentional.current){void audio.close();return;}
        playRingback();
        const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
        if(!alive.current||intentional.current||epoch!==generation.current){media.getTracks().forEach(t=>t.stop());void audio.close();return;}
        stream.current = media;media.getAudioTracks().forEach(t=>t.enabled=!currentMuted.current);
        await Promise.all([audio.audioWorklet.addModule(`${BASE_PATH}/pp-dot-audio-worklet.js`),audio.audioWorklet.addModule(`${BASE_PATH}/pp-dot-playback-worklet.js`)]);
        if(epoch!==generation.current){media.getTracks().forEach(t=>t.stop());void audio.close();return;}
        if(!alive.current||intentional.current){cleanupAudio();return;}
        const output = new AudioWorkletNode(audio,'pp-dot-playback',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
        playback.current=output;output.connect(audio.destination);
        output.onprocessorerror=()=>{if(epoch!==generation.current)return;setError('语音播放发生错误，通话已停止。请重新开始。');hangup();};
        const transport=new VoiceRecovery(event=>send(event),message=>setError(message));
        recoveryState.current=transport;pendingPing.current=0;
        output.port.postMessage({type:'mute',muted:currentMuted.current});
        output.port.onmessage=({data})=>{
            if(epoch!==generation.current||playback.current!==output)return;
            if(data.type==='speech')transport.activity(data.active,data.at,data.speechStart);
            if(data.type==='invalidate'){
                stopRingback();setOutputLevel(0);setBuffering(false);setWaiting(false);
                transport.invalidate(data.recoveryId,data.reason,data.at,data.speechStart);
                setState(data.reason==='stop_audio'?'output_stopped':'resynchronizing');
            }
            if(data.type==='played'&&transport.accepts(data.callId,data.recoveryId))send(data);
            if(data.type==='level'&&data.recoveryId===transport.recoveryId){setOutputLevel(data.rms);if(data.rms>.006)setWaiting(false);setBuffering(data.buffering&&data.queuedMs>0);}
        };
        const node = new AudioWorkletNode(audio, 'pp-dot-capture');
        capture.current = node;
        const microphone=audio.createMediaStreamSource(media);microphone.connect(node);microphone.connect(output);
        node.connect(audio.destination);
        node.port.onmessage = ({data}) => {
            if(epoch!==generation.current||capture.current!==node)return;
            const pcm=new Int16Array(data.pcm),level=Math.sqrt(pcm.reduce((n,x)=>n+(x/32768)**2,0)/Math.max(pcm.length,1));
            setInputLevel(currentMuted.current?0:level);if(currentMuted.current)return;
            if(audio.currentTime-data.at>1.8&&!transport.blocked){transport.freeze();output.port.postMessage({type:'invalidate',reason:'capture_delay'});setError('页面处理曾暂停，正在恢复最新发言。若漏掉内容，请完整重复该句。');}
            let binary='';for(const b of new Uint8Array(data.pcm))binary+=String.fromCharCode(b);
            transport.capture({audio:btoa(binary),seq:data.seq,at:data.at},audio.currentTime);
        };
        transportTimer.current=setInterval(()=>{
            if(epoch!==generation.current||socket.current?.readyState!==WebSocket.OPEN)return;
            if(socket.current.bufferedAmount>64000){transport.freeze();output.port.postMessage({type:'invalidate',reason:'input_congestion'});return;}
            const now=performance.now();
            if(pendingPing.current&&now-pendingPing.current>1800){transport.freeze();output.port.postMessage({type:'invalidate',reason:'transport_delay'});return;}
            if(!pendingPing.current){pendingPing.current=now;send({type:'ping',at:now});}
            if(!currentMuted.current)transport.drain(audio.currentTime);
            if(transport.accepts(transport.callId,transport.recoveryId))setState(transport.synchronizing?'resynchronizing':currentMuted.current?'muted':'listening');
        },100);
        await connect(takeover);
    }
    catch (e) {
        if(epoch!==generation.current)return;
        intentional.current = true;
        cleanupAudio();
        setState('failed');
        setError(e instanceof Error ? e.message : '无法打开麦克风。');
    }
    finally {
        if(epoch===generation.current){setBusy(false);busyRef.current=false;}
    } }
    function hangup(paused=false) {generation.current++;busyRef.current=false;setBusy(false); intentional.current = true;if(reconnect.current)clearTimeout(reconnect.current);send({type:'hangup'});socket.current?.close();socket.current=null;cleanupAudio();setState(paused?'paused':'ended');if(!paused){onActivityChange(false);setCallControls(false);setCallOwner(null);callConversation.current=null;}}
    function toggleMute(){const v=!currentMuted.current;currentMuted.current=v;setMuted(v);stream.current?.getAudioTracks().forEach(t=>t.enabled=!v);if(v)setInputLevel(0);playback.current?.port.postMessage({type:'mute',muted:v});send({type:'mute',muted:v});}
    const connected=['connecting','listening','muted','reconnecting','resynchronizing','output_stopped'].includes(state);
    const labels:Record<string,string>={connecting:'正在连接',reconnecting:'正在恢复连接',resynchronizing:inputLevel>0.01?'正在听你说 · 同步中':'正在同步最新发言',output_stopped:'播报已停止 · 可以继续说',listening:outputLevel>0.006?'正在说话':buffering?'正在准备回答':inputLevel>0.01?'正在听你说':waiting?'正在思考':'正在倾听',muted:outputLevel>0.006?'正在说话 · 麦克风已静音':'麦克风已静音',paused:'通话已暂停',failed:'连接失败',ended:'通话已结束'};
    const status=labels[state]??state;
    const value:Controls={selectedId:conversationId,owner:callOwner,available:Boolean(enabled&&!recordingBusy&&availability?.available&&availability.conversationId===conversationId&&!permissionDenied&&typeof navigator.mediaDevices?.getUserMedia==='function'&&typeof window.AudioWorkletNode==='function'),connected,state,body:Boolean(callOwner?.id===conversationId&&callControls),status,error,busy,muted,inputLevel,outputLevel,execution,start:()=>void start(),takeover:()=>void start(true,true),resume:()=>void start(false,true),pause:()=>hangup(true),end:()=>hangup(),mute:toggleMute,stop:()=>{setOutputLevel(0);playback.current?.port.postMessage({type:'invalidate',reason:'stop_audio'});},chat:()=>setCallControls(false),show:()=>setCallControls(true)};
    const elsewhere=Boolean(callOwner&&(!workspaceVisible||callOwner.id!==conversationId));
    return <VoiceContext.Provider value={value}>{children}{elsewhere&&createPortal(<aside className="voice-presence" aria-label="其他会话中的通话"><button onClick={()=>{onOpen(callOwner!.id);setCallControls(true);}}><Phone size={18}/><span>{callOwner!.title} · {status}</span><ArrowUpRight size={16}/></button><button onClick={toggleMute} aria-label={muted?'开启麦克风':'静音'}>{muted?<MicOff/>:<Mic/>}</button><button onClick={()=>hangup()} aria-label="结束通话"><PhoneOff/></button></aside>,document.body)}<span className="voice-sr-only" aria-live="polite">{callOwner?status:''}</span></VoiceContext.Provider>;
}
function LevelBars({level,label}:{level:number;label:string}){return <div className="voice-level" role="img" aria-label={label} data-level={level.toFixed(3)}>{[.45,.7,1,.75,.5].map((gain,i)=><i key={i} style={{height:`${6+Math.min(1,level*8)*64*gain}px`}}/>)}</div>;}
export function ConversationVoiceWorkspace({children}:{children:ReactNode}){const v=useContext(VoiceContext), workspace=useRef<HTMLElement|null>(null);useEffect(()=>{if(v?.body)workspace.current?.focus();},[v?.body]);const current=v?.owner?.id===v?.selectedId&&Boolean(v?.owner);return <>
  {current&&v&&!v.body&&<div className="voice-chat-strip"><button onClick={v.show}><Phone size={18}/>返回通话 · {v.status}</button><button onClick={v.mute} aria-label={v.muted?'开启麦克风':'静音'}>{v.muted?<MicOff size={18}/>:<Mic size={18}/>}</button><button onClick={v.end} aria-label="结束通话"><PhoneOff size={18}/></button></div>}
  <div className="voice-chat-content" style={v?.body?{display:'none'}:undefined}>{children}</div>
  {v?.body&&<section ref={workspace} tabIndex={-1} className="voice-workspace" aria-label="实时通话"><div className="voice-workspace-top"><span>实时通话</span><button onClick={v.chat}><MessageSquare size={18}/>查看聊天</button></div><div className="voice-center"><div className="voice-speakers"><div className="voice-assistant"><LevelBars level={v.outputLevel} label="助手实际播放音量"/><small>助手</small></div><div className="voice-user"><LevelBars level={v.inputLevel} label="麦克风实际输入音量"/><small>{v.muted?'麦克风已静音':'你'}</small></div></div><p className="voice-status" role="status">{v.status}</p>{v.error&&<div className="voice-error" role="alert">{v.error}{v.error.includes('另一端')&&<button onClick={v.takeover} disabled={v.busy}>接管通话</button>}</div>}{v.execution&&<p className="voice-execution" role="status">{v.execution}</p>}</div><div className="voice-bottom"><div className="voice-primary-controls">{v.connected?<><button aria-pressed={v.muted} onClick={v.mute}>{v.muted?<MicOff/>:<Mic/>}<span>{v.muted?'取消静音':'静音'}</span></button><button onClick={v.pause}><Pause/><span>暂停</span></button></>:<button onClick={v.resume} disabled={v.busy}><Play/><span>{v.state==='paused'?'继续通话':'重试连接'}</span></button>}<button className="voice-end" onClick={v.end}><PhoneOff/><span>结束</span></button></div><button className="voice-stop-output" onClick={v.stop} disabled={!v.connected}><VolumeX size={17}/>停止播报</button><p>暂停或结束通话，后台任务继续。</p></div></section>}
</>;}
