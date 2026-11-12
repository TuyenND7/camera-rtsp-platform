import { createContext, useContext, type ReactNode } from 'react';
import Icon, { IconName } from './Icon';
import type { SessionUser } from './api';

export const NavigationContext = createContext<{ expanded: boolean; toggle: () => void } | null>(null);
export const SessionContext = createContext<SessionUser | null>(null);

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: string; actions?: ReactNode; eyebrow?: string }) {
  const navigation = useContext(NavigationContext);
  return <header className="page-heading"><div className="page-heading-title">{navigation && <button type="button" className="icon-button sidebar-visibility-toggle" onClick={navigation.toggle} aria-controls="app-navigation" aria-expanded={navigation.expanded} aria-label={navigation.expanded ? 'Ẩn menu' : 'Hiện menu'} title={navigation.expanded ? 'Ẩn menu' : 'Hiện menu'}><Icon name="menu" /></button>}<div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export const statusLabels: Record<string, string> = { online: 'Trực tuyến', connecting: 'Đang kết nối lại', error: 'Mất kết nối', stopped: 'Đã dừng' };

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}><i className={`status-dot ${status}`} />{statusLabels[status] ?? status}</span>;
}

export function Metric({ icon, label, value, hint, tone = '' }: { icon: IconName; label: string; value: ReactNode; hint?: string; tone?: string }) {
  return <article className={`metric-card ${tone}`}><div className="metric-icon"><Icon name={icon} size={21} /></div><div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div></article>;
}

export function EmptyState({ icon = 'camera', title, children, action }: { icon?: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={28} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function cameraHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'Chưa cấu hình'; }
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}
