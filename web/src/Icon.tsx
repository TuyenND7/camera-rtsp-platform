import { atlasWidth, atlasHeight, regularIconBounds } from './regularIconAtlas';

const icons = [
  'camera', 'chevronDown', 'clock', 'folder', 'grid', 'layout',
  'monitor', 'pause', 'play', 'refresh', 'rewind', 'search',
  'settings', 'skipBack', 'skipForward', 'user', 'video', 'zoomIn',
  'zoomOut', 'server', 'shield', 'plus', 'close', 'logout',
  'chevronRight', 'database', 'bell', 'check', 'edit', 'trash',
  'menu', 'network', 'maximize', 'minimize', 'sun', 'moon',
  'volume', 'volumeMuted', 'microphone', 'microphoneOff',
] as const;

export type IconName = typeof icons[number];

/** Imagegen supplies the shape; currentColor preserves the UI palette. */
export default function Icon({ name, size = 20, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const index = icons.indexOf(name);
  const [x, y, width, height] = regularIconBounds[index];
  const scale = size * 0.88 / Math.max(width, height);
  const position = `calc(${size / 2 - (x + width / 2) * scale}px * var(--icon-scale, 1)) calc(${size / 2 - (y + height / 2) * scale}px * var(--icon-scale, 1))`;
  const maskSize = `calc(${atlasWidth * scale}px * var(--icon-scale, 1)) calc(${atlasHeight * scale}px * var(--icon-scale, 1))`;
  const maskImage = 'url(/brand/camera-icons-balanced.png)';
  return <span aria-hidden="true" className={`app-icon${className ? ` ${className}` : ''}`} style={{
    width: `calc(${size}px * var(--icon-scale, 1))`, height: `calc(${size}px * var(--icon-scale, 1))`, minWidth: `calc(${size}px * var(--icon-scale, 1))`, maxWidth: `calc(${size}px * var(--icon-scale, 1))`, minHeight: `calc(${size}px * var(--icon-scale, 1))`, maxHeight: `calc(${size}px * var(--icon-scale, 1))`, flex: '0 0 auto',
    display: 'inline-block', padding: 0, border: 0, borderRadius: 0, backgroundColor: 'currentColor',
    maskImage, WebkitMaskImage: maskImage,
    maskSize, WebkitMaskSize: maskSize,
    maskPosition: position, WebkitMaskPosition: position,
  }} />;
}
