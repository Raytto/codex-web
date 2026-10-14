import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './opportunities.css';
export function OpportunityDialog({title,onClose,children,closeDisabled=false}:{title:string;onClose:()=>void;children:ReactNode;closeDisabled?:boolean}){
 const ref=useRef<HTMLElement>(null),close=useRef<HTMLButtonElement>(null),closeAction=useRef(onClose);closeAction.current=()=>{if(!closeDisabled)onClose();};
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;close.current?.focus();const down=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();closeAction.current();}if(e.key==='Tab'){const items=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')??[]).filter(n=>n.offsetParent!==null);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',down);return()=>{document.removeEventListener('keydown',down);previous?.isConnected&&previous.focus();};},[]);
 return createPortal(<div className="opportunity-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)closeAction.current();}}><section ref={ref} className="opportunity-dialog ui-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2 className="dialog-title">{title}</h2><button ref={close} className="icon-button" onClick={()=>closeAction.current()} disabled={closeDisabled} aria-label="关闭弹窗"><X size={18}/></button></header><div className="opportunity-dialog-body">{children}</div></section></div>,document.body);
}
