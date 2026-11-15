import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Icon from './Icon';

export type LayoutSize = 1 | 4 | 9 | 16;
export type LiveLayout = LayoutSize | 'list';
const sizes: LiveLayout[] = [1, 4, 9, 16, 'list'];
const label = (size: LiveLayout) => size === 'list' ? 'Danh sách' : size === 1 ? '1' : `${Math.sqrt(size)}×${Math.sqrt(size)}`;
const storageKey = 'camera-station.live-layout';

export function initialLiveLayout(): LiveLayout {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'list') return saved;
    const size = Number(saved);
    if (sizes.includes(size as LayoutSize)) return size as LayoutSize;
  } catch { /* Fall back to the current viewing device. */ }
  return window.matchMedia('(max-width: 600px)').matches ? 'list' : 4;
}
export function rememberLiveLayout(value: LiveLayout) {
  try { localStorage.setItem(storageKey, String(value)); } catch { /* Layout still works without storage. */ }
}

export default function LiveLayoutPicker({ value, onChange }: { value: LiveLayout; onChange: (size: LiveLayout) => void }) {
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
    }}><Icon name={value === 'list' ? 'menu' : 'layout'} size={18} /><span>{label(value)}</span><Icon name="chevronDown" size={14} /></button>
    {open && <div ref={menu} className="live-layout-menu" role="menu" aria-label="Bố cục camera" onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      const index = Math.max(0, buttons.findIndex(button => button === document.activeElement));
      const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length]?.focus();
    }}>{sizes.map(size => <button key={size} type="button" role="menuitemradio" tabIndex={-1} aria-label={`Bố cục ${label(size)}`} aria-checked={value === size} onClick={() => { onChange(size); close(); }}>
      <span className="live-layout-preview" aria-hidden="true" style={{ '--layout-columns': size === 'list' ? 1 : Math.sqrt(size) } as CSSProperties}>{Array.from({ length: size === 'list' ? 3 : size }, (_, index) => <i key={index} />)}</span>
      <span>{label(size)}</span>{value === size && <Icon name="check" size={16} />}
    </button>)}</div>}
  </div>;
}
