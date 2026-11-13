import './threadpool'; // phải đứng đầu: đặt UV_THREADPOOL_SIZE trước khi libuv khởi tạo
import express from 'express';
import { config } from './config';
import { initDb, waitForDb } from './db';
import { streamManager } from './stream/manager';
import { startRetentionJob } from './stream/retention';
import { startThumbnailJob } from './stream/thumbnails';
import authRoutes from './routes/auth';
import cameraRoutes from './routes/cameras';
import ptzRoutes from './routes/ptz';
import recordingRoutes from './routes/recordings';
import eventRoutes from './routes/events';
import settingsRoutes from './routes/settings';
import talkRoutes from './routes/talk';
import controlRoutes from './routes/controls';
import videoSettingsRoutes from './routes/videoSettings';
import { deviceControls } from './controls/tenda';
import { talkManager } from './talk/manager';
import { loadSettings } from './settings';
import { browserRequestGuard } from './middleware/security';

async function main() {
  await waitForDb();
  await initDb();
  await loadSettings();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // backend is private; nginx overwrites forwarded headers
  app.use('/api', browserRequestGuard);
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/cameras/:id/ptz', ptzRoutes);
  app.use('/api/cameras/:id/controls', controlRoutes);
  app.use('/api/cameras/:id/video-settings', videoSettingsRoutes);
  app.use('/api/cameras', cameraRoutes);
  app.use('/api/recordings', recordingRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/talk', talkRoutes);

  // Khởi động worker cho các camera đang bật
  await streamManager.bootstrap();
  const retentionTimer = startRetentionJob();
  const thumbnailJob = startThumbnailJob();

  const server = app.listen(config.port, () => {
    console.log(`[backend] listening on :${config.port}`);
  });

  const shutdown = () => {
    console.log('[backend] shutting down...');
    clearInterval(retentionTimer);
    thumbnailJob.stop();
    talkManager.close();
    deviceControls.close();
    streamManager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[backend] fatal:', err);
  process.exit(1);
});
