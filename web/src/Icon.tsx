import type { ReactNode } from 'react';

export type IconName =
  | 'camera' | 'chevronDown' | 'clock' | 'folder' | 'grid' | 'layout'
  | 'monitor' | 'pause' | 'play' | 'refresh' | 'rewind' | 'search' | 'settings'
  | 'skipBack' | 'skipForward' | 'user' | 'video' | 'zoomIn' | 'zoomOut'
  | 'server' | 'shield' | 'plus' | 'close' | 'logout' | 'chevronRight'
  | 'database' | 'bell' | 'check' | 'edit' | 'trash' | 'menu' | 'network';

export default function Icon({ name, size = 20, stroke = 1.8, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  const paths: Record<IconName, ReactNode> = {
    server: <><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    logout: <><path d="M10 4H5v16h5M9 12h12m-4-4 4 4-4 4"/></>,
    chevronRight: <path d="m9 6 6 6-6 6"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14Z"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    network: <><rect x="8" y="3" width="8" height="6" rx="1"/><rect x="2" y="16" width="7" height="5" rx="1"/><rect x="15" y="16" width="7" height="5" rx="1"/><path d="M12 9v4M5.5 16v-3h13v3"/></>,
    camera: <><path d="m2 7 3-2h7l2 2h4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="11.5" cy="13" r="3"/></>,
    chevronDown: <path d="m6 9 6 6 6-6"/>,
    clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></>,
    folder: <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/>,
    grid: <><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><rect x="14" y="14" width="6.5" height="6.5" rx="1"/></>,
    layout: <><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M10 9.5V20"/></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
    pause: <><path d="M8 5v14M16 5v14"/></>,
    play: <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/></>,
    rewind: <><path d="m11 6-6 6 6 6V6Zm8 0-6 6 6 6V6Z"/></>,
    search: <><circle cx="10.7" cy="10.7" r="6.2"/><path d="m15.5 15.5 4 4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.2 2.2-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55v.1h-3.12v-.1a1.7 1.7 0 0 0-1.03-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.2-2.2.06-.06A1.7 1.7 0 0 0 6.74 15a1.7 1.7 0 0 0-1.55-1.03h-.1v-3.12h.1a1.7 1.7 0 0 0 1.55-1.03 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.2-2.2.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.55v-.1h3.12v.1a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.2 2.2-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.03h.1v3.12h-.1A1.7 1.7 0 0 0 19.4 15Z"/></>,
    skipBack: <><path d="M7 6v12M18 6l-8 6 8 6Z"/></>,
    skipForward: <><path d="M17 6v12M6 6l8 6-8 6Z"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.8-3.3 3.2-5 7.5-5s6.7 1.7 7.5 5"/></>,
    video: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 16.5Z"/><path d="m16 10 4.2-2.2c.8-.4 1.8.1 1.8 1v6.4c0 .9-1 1.4-1.8 1L16 14"/></>,
    zoomIn: <><circle cx="10.5" cy="10.5" r="6"/><path d="M10.5 7.5v6m-3-3h6m2.2 4.2 4.3 4.3"/></>,
    zoomOut: <><circle cx="10.5" cy="10.5" r="6"/><path d="M7.5 10.5h6m2.2 4.2 4.3 4.3"/></>,
  };
  return <svg {...common} className={className}>{paths[name]}</svg>;
}
