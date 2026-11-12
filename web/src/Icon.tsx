import { atlasSize, iconBounds } from './iconAtlas';

const icons = [
  'camera', 'chevronDown', 'clock', 'folder', 'grid', 'layout',
  'monitor', 'pause', 'play', 'refresh', 'rewind', 'search',
  'settings', 'skipBack', 'skipForward', 'user', 'video', 'zoomIn',
  'zoomOut', 'server', 'shield', 'plus', 'close', 'logout',
  'chevronRight', 'database', 'bell', 'check', 'edit', 'trash',
  'menu', 'network', 'maximize', 'minimize', 'sun', 'moon',
] as const;

export type IconName = typeof icons[number];

/** Imagegen supplies the shape; currentColor preserves the UI palette. */
export default function Icon({ name, size = 20, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const index = icons.indexOf(name);
  const [x, y, width, height] = iconBounds[index];
  const scale = size * 0.88 / Math.max(width, height);
  const position = `${size / 2 - (x + width / 2) * scale}px ${size / 2 - (y + height / 2) * scale}px`;
  const maskSize = `${atlasSize * scale}px ${atlasSize * scale}px`;
  return <span aria-hidden="true" className={`app-icon${className ? ` ${className}` : ''}`} style={{
    width: size, height: size, minWidth: size, maxWidth: size, minHeight: size, maxHeight: size, flex: '0 0 auto',
    display: 'inline-block', padding: 0, border: 0, borderRadius: 0, backgroundColor: 'currentColor',
    maskImage: 'url(/brand/camera-icons.png)', WebkitMaskImage: 'url(/brand/camera-icons.png)',
    maskSize, WebkitMaskSize: maskSize,
    maskPosition: position, WebkitMaskPosition: position,
  }} />;
}
