import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Icon from './Icon';

export type LayoutSize = 1 | 4 | 9 | 16;
const sizes: LayoutSize[] = [1, 4, 9, 16];
const label = (size: LayoutSize) => size === 1 ? '1' : `${Math.sqrt(size)}×${Math.sqrt(size)}`;

export default function LiveLayoutPicker({ value, onChange }: { value: LayoutSize; onChange: (size: LayoutSize) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  return <div ref={root} className="mi-layout-control" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab' && open) close();
  }}>
    <button ref={trigger} type="button" className="mi-layout-picker" aria-label="Chọn bố cục Live view" aria-haspopup="menu" aria-expanded={open} title={`Bố cục ${label(value)}`} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
    }}><Icon name="layout" size={18} /><span>{label(value)}</span><Icon name="chevronDown" size={14} /></button>
    {open && <div ref={menu} className="live-layout-menu" role="menu" aria-label="Bố cục camera" onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      const index = Math.max(0, buttons.findIndex(button => button === document.activeElement));
      const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length]?.focus();
    }}>{sizes.map(size => <button key={size} type="button" role="menuitemradio" tabIndex={-1} aria-label={`Bố cục ${label(size)}`} aria-checked={value === size} onClick={() => { onChange(size); close(); }}>
      <span className="live-layout-preview" aria-hidden="true" style={{ '--layout-columns': Math.sqrt(size) } as CSSProperties}>{Array.from({ length: size }, (_, index) => <i key={index} />)}</span>
      <span>{label(size)}</span>{value === size && <Icon name="check" size={16} />}
    </button>)}</div>}
  </div>;
}
