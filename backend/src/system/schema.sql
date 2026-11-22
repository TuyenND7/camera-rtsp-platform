CREATE TABLE IF NOT EXISTS system_preferences (
  id SMALLINT PRIMARY KEY CHECK(id=1), value JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS system_runtime (
  id SMALLINT PRIMARY KEY CHECK(id=1), value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS camera_health_incidents (
  id UUID PRIMARY KEY, camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, message TEXT NOT NULL, opened_at TIMESTAMPTZ NOT NULL,
  recovered_at TIMESTAMPTZ, notification_id BIGINT REFERENCES surveillance_notifications(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_health_open ON camera_health_incidents(camera_id,kind) WHERE recovered_at IS NULL;
CREATE TABLE IF NOT EXISTS recording_gaps (
  id BIGSERIAL PRIMARY KEY, camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL DEFAULT 'missing_recording',
  CHECK(end_at>start_at), UNIQUE(camera_id,start_at,end_at)
);
CREATE INDEX IF NOT EXISTS idx_recording_gaps_time ON recording_gaps(camera_id,start_at DESC);
ALTER TABLE surveillance_notifications ADD COLUMN IF NOT EXISTS message TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='surveillance_notifications'::regclass AND conname='surveillance_notifications_kind_check' AND pg_get_constraintdef(oid) LIKE '%camera_offline%') THEN
    ALTER TABLE surveillance_notifications DROP CONSTRAINT IF EXISTS surveillance_notifications_kind_check;
    ALTER TABLE surveillance_notifications ADD CONSTRAINT surveillance_notifications_kind_check CHECK(kind IN ('intrusion','loitering','pacing','unfamiliar','camera_offline','video_stalled','recording_stopped','storage_error','resource_overload'));
  END IF;
END $$;
