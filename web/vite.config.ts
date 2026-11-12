import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { uiPreviewPlugin } from './dev/uiPreview';

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'ui-preview') {
    throw new Error('UI preview is development-only. Use npm run build for production.');
  }
  const preview = command === 'serve' && mode === 'ui-preview';
  return {
    plugins: [react(), ...(preview ? [uiPreviewPlugin()] : [])],
    server: {
      port: 5173,
      proxy: preview ? {} : {
        // dev: proxy API + streams sang backend/nginx
        '/api': 'http://localhost:4000',
        '/live/': 'http://localhost:8080',
        '/rec': 'http://localhost:8080',
        '^/playback/.+\\.(m3u8|ts)$': 'http://localhost:8080',
        '/thumbs': 'http://localhost:8080',
        '/events/': 'http://localhost:8080',
      },
    },
  };
});
