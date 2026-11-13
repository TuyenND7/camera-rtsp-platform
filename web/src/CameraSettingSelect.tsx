import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon, { IconName } from './Icon';

export type SettingOption = { value: string; label: string; description?: string; current?: boolean; disabled?: boolean };

export default function CameraSettingSelect({ label, value, options, onChange, disabled, help, description, icon, columns = 2 }: {
  label: string; value: string; options: SettingOption[]; onChange: (value: string) => void;
  disabled?: boolean; help?: string; description: string; icon: IconName; columns?: 1 | 2;
}) {
  const id = useId(), [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <div className="camera-setting-field">
    <span id={`${id}-label`} className="camera-setting-label">{label}</span>
    <button type="button" className="camera-setting-trigger" disabled={disabled} aria-label={`Chọn ${label.toLocaleLowerCase('vi-VN')}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span className="camera-setting-trigger-icon"><Icon name={icon} size={22} /></span>
      <span className="camera-setting-trigger-value"><strong>{selected?.label || 'Chưa có lựa chọn'}</strong>{selected?.description && <small>{selected.description}</small>}</span>
      <Icon name="chevronDown" size={20} />
    </button>
    {help && <small className="camera-setting-help">{help}</small>}
    {open && !disabled && createPortal(<ChoiceDialog label={label} description={description} icon={icon} columns={columns} value={value} options={options} onClose={() => setOpen(false)} onChoose={next => { onChange(next); setOpen(false); }} />, document.body)}
  </div>;
}

function ChoiceDialog({ label, description, icon, columns, value, options, onClose, onChoose }: {
  label: string; description: string; icon: IconName; columns: 1 | 2;
  value: string; options: SettingOption[]; onClose: () => void; onChoose: (value: string) => void;
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), group = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(value);
  const valid = options.some(option => option.value === draft && !option.disabled);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    group.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  function navigate(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)') ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = Math.max(0, buttons.findIndex(button => button === document.activeElement));
    const visibleColumns = group.current ? getComputedStyle(group.current).gridTemplateColumns.split(' ').filter(Boolean).length : columns;
    const step = event.key === 'ArrowUp' ? -visibleColumns : event.key === 'ArrowDown' ? visibleColumns : event.key === 'ArrowLeft' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
    setDraft(buttons[next].dataset.value!); buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest' });
  }
  return <dialog ref={dialog} className="device-dialog camera-choice-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header className="camera-choice-heading"><span className="camera-choice-heading-icon"><Icon name={icon} size={25} /></span><div><h2 id={`${id}-title`}>Chọn {label.toLocaleLowerCase('vi-VN')}</h2><p id={`${id}-description`}>{description}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label={`Đóng chọn ${label.toLocaleLowerCase('vi-VN')}`}><Icon name="close" size={21} /></button></header>
    <div ref={group} className={`camera-choice-options columns-${columns}`} role="radiogroup" aria-labelledby={`${id}-title`} onKeyDown={navigate}>{options.map(option => <button key={option.value} type="button" role="radio" aria-checked={draft === option.value} disabled={option.disabled} data-value={option.value} tabIndex={draft === option.value || !valid && option === options.find(item => !item.disabled) ? 0 : -1} className={`camera-choice-option${draft === option.value ? ' selected' : ''}`} onClick={() => setDraft(option.value)}>
      <span className="camera-choice-option-content"><span className="camera-choice-option-title"><strong>{option.label}</strong>{option.current && <span className="camera-choice-current">Đang dùng</span>}</span>{option.description && <small>{option.description}</small>}</span><span className="camera-choice-radio" aria-hidden="true">{draft === option.value && <Icon name="check" size={14} />}</span>
    </button>)}</div>
    <footer className="camera-choice-footer"><button type="button" onClick={onClose}>Hủy</button><button type="button" className="primary" disabled={!valid} onClick={() => { if (valid) onChoose(draft); }}><Icon name="check" size={18} />Chọn</button></footer>
  </dialog>;
}
