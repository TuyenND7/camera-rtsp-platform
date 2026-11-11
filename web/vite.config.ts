import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // dev: proxy API + streams sang backend/nginx
      '/api': 'http://localhost:4000',
      '/live/': 'http://localhost:8080',
      '/rec': 'http://localhost:8080',
      '^/playback/.+\\.(m3u8|ts)$': 'http://localhost:8080',
      '/thumbs': 'http://localhost:8080',
      '/events/': 'http://localhost:8080',
    },
  },
});
