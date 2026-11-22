import { useEffect,useRef,useState } from 'react';
import Icon from './Icon';
import './system-settings.css';
export default function DeferredSettings({title,anchor,icon,children}:{title:string;anchor:string;icon:'server'|'bell'|'clock';children:React.ReactNode}){
  const [open,setOpen]=useState(()=>window.location.hash===`#${anchor}`),element=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const reveal=()=>{if(window.location.hash===`#${anchor}`){setOpen(true);requestAnimationFrame(()=>element.current?.scrollIntoView({block:'start'}));}};
    reveal();window.addEventListener('hashchange',reveal);return()=>window.removeEventListener('hashchange',reveal);
  },[anchor]);
  return <details ref={element} id={`settings-${anchor}`} className="panel deferred-settings" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary><Icon name={icon} size={20}/><strong>{title}</strong><Icon name="chevronDown" size={17}/></summary>
    {open&&<div className="deferred-settings-body">{children}</div>}
  </details>;
}
