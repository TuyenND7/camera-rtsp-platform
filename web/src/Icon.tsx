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
  const position = `${size / 2 - (x + width / 2) * scale}px ${size / 2 - (y + height / 2) * scale}px`;
  const maskSize = `${atlasWidth * scale}px ${atlasHeight * scale}px`;
  const maskImage = 'url(/brand/camera-icons-balanced.png)';
  return <span aria-hidden="true" className={`app-icon${className ? ` ${className}` : ''}`} style={{
    width: size, height: size, minWidth: size, maxWidth: size, minHeight: size, maxHeight: size, flex: '0 0 auto',
    display: 'inline-block', padding: 0, border: 0, borderRadius: 0, backgroundColor: 'currentColor',
    maskImage, WebkitMaskImage: maskImage,
    maskSize, WebkitMaskSize: maskSize,
    maskPosition: position, WebkitMaskPosition: position,
  }} />;
}
