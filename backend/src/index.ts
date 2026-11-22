import './threadpool'; // phải đứng đầu: đặt UV_THREADPOOL_SIZE trước khi libuv khởi tạo
import express from 'express';
import { config } from './config';
import { initDb, waitForDb } from './db';
import { streamManager } from './stream/manager';
import { startRetentionJob, configureRetentionGuard } from './stream/retention';
import { startThumbnailJob } from './stream/thumbnails';
import { flushStreamDiagnostics } from './stream/diagnostics';
import authRoutes from './routes/auth';
import cameraRoutes from './routes/cameras';
import ptzRoutes from './routes/ptz';
import recordingRoutes from './routes/recordings';
import eventRoutes from './routes/events';
import identityRoutes from './routes/identities';
import surveillanceRoutes, { cameraSurveillanceRouter } from './routes/surveillance';
import settingsRoutes from './routes/settings';
import talkRoutes from './routes/talk';
import controlRoutes from './routes/controls';
import videoSettingsRoutes from './routes/videoSettings';
import deviceSettingsRoutes from './routes/deviceSettings';
import { deviceControls } from './controls/tenda';
import { talkManager } from './talk/manager';
import { loadSettings } from './settings';
import { browserRequestGuard, jsonRequestError } from './middleware/security';
import operationsRoutes from './operations/routes';
import { startOperatingProfiles } from './operations/profiles';
import { startPushDelivery } from './operations/push';
import evidenceRoutes from './routes/evidence';
import { startEvidenceJobs, withEvidenceRetentionGuard, setEvidenceLimits } from './evidence/jobs';
import { evidenceLimits } from './evidence/limits';
import systemRoutes from './routes/system';
import { startPerformance, setBudgetListener } from './system/performance';
import { systemHealth } from './system/health';

async function main() {
  await waitForDb();
  await initDb();
  await loadSettings();
  const evidenceDefaults=evidenceLimits();
  setBudgetListener(budget=>setEvidenceLimits({threads:budget.threads?Math.min(budget.threads,evidenceDefaults.threads):evidenceDefaults.threads,preset:budget.preset??evidenceDefaults.preset}));
  const performanceService=await startPerformance();
  const profileService=await startOperatingProfiles();
  const evidenceService=await startEvidenceJobs();
  configureRetentionGuard(withEvidenceRetentionGuard);
  const pushService=startPushDelivery();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // backend is private; nginx overwrites forwarded headers
  app.use('/api', browserRequestGuard);
  app.use(express.json({ limit: '16kb' }));
  app.use(jsonRequestError);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/cameras/:id/ptz', ptzRoutes);
  app.use('/api/cameras/:id/controls', controlRoutes);
  app.use('/api/cameras/:id/video-settings', videoSettingsRoutes);
  app.use('/api/cameras/:id/device-settings', deviceSettingsRoutes);
  app.use('/api/cameras/:id/surveillance', cameraSurveillanceRouter);
  app.use('/api/cameras', cameraRoutes);
  app.use('/api/recordings', recordingRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/identities', identityRoutes);
  app.use('/api/surveillance', surveillanceRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/talk', talkRoutes);
  app.use('/api/operations',operationsRoutes);
  app.use('/api/evidence',evidenceRoutes);
  app.use('/api/system',systemRoutes);

  // Khởi động worker cho các camera đang bật
  await streamManager.bootstrap();
  const healthService=await systemHealth.start();
  const retentionTimer = startRetentionJob();
  const thumbnailJob = startThumbnailJob();

  const server = app.listen(config.port, () => {
    console.log(`[backend] listening on :${config.port}`);
  });

  const shutdown = () => {
    console.log('[backend] shutting down...');
    clearInterval(retentionTimer);
    performanceService.stop();profileService.stop();healthService.stop();pushService.stop();
    thumbnailJob.stop();
    talkManager.close();
    deviceControls.close();
    streamManager.stopAll();
    const cleanup=Promise.allSettled([evidenceService.close(),flushStreamDiagnostics()]);
    server.close(() => { void cleanup.finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[backend] fatal:', err);
  process.exit(1);
});
