import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import Icon from './Icon';

export type LayoutSize = 1 | 4 | 9 | 16;
const sizes: LayoutSize[] = [1, 4, 9, 16];
const label = (size: LayoutSize) => size === 1 ? '1' : `${Math.sqrt(size)}×${Math.sqrt(size)}`;

export default function LiveLayoutPicker({ value, onChange }: { value: LayoutSize; onChange: (size: LayoutSize) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="mi-layout-picker" aria-label="Chọn bố cục Live view" aria-haspopup="dialog" aria-expanded={open} title={`Bố cục ${label(value)}`} onClick={() => setOpen(true)}><Icon name="layout" size={18} /><span>{label(value)}</span><Icon name="chevronDown" size={14} /></button>
    {open && <LayoutDialog value={value} onClose={() => setOpen(false)} onChoose={size => { onChange(size); setOpen(false); }} />}
  </>;
}

function LayoutDialog({ value, onChoose, onClose }: { value: LayoutSize; onChoose: (size: LayoutSize) => void; onClose: () => void }) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="device-dialog live-layout-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header className="dialog-heading"><h2 id={id}>Chọn bố cục</h2><button type="button" className="icon-button" aria-label="Đóng chọn bố cục" onClick={onClose}><Icon name="close" size={20} /></button></header>
    <div className="live-layout-options" role="group" aria-label="Bố cục camera" onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      const index = Math.max(0, buttons.findIndex(button => button === document.activeElement));
      const step = event.key === 'ArrowUp' ? -2 : event.key === 'ArrowDown' ? 2 : event.key === 'ArrowLeft' ? -1 : 1;
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length]?.focus();
    }}>{sizes.map(size => <button key={size} type="button" aria-label={`Bố cục ${label(size)}`} aria-pressed={value === size} onClick={() => onChoose(size)}>
      <span className="live-layout-preview" aria-hidden="true" style={{ '--layout-columns': Math.sqrt(size) } as CSSProperties}>{Array.from({ length: size }, (_, index) => <i key={index} />)}</span>
      <strong>{label(size)}</strong>{value === size && <Icon name="check" size={16} />}
    </button>)}</div>
  </dialog>;
}
