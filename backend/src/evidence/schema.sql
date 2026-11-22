-- Append to backend schema.sql after cameras/detection_events/surveillance_notifications.
CREATE TABLE IF NOT EXISTS evidence_clips (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('protected','preview')),
  camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  camera_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing','queued','processing','ready','error','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  reserved_bytes BIGINT NOT NULL DEFAULT 0,
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  event_id BIGINT REFERENCES detection_events(id) ON DELETE SET NULL,
  notice_id BIGINT REFERENCES surveillance_notifications(id) ON DELETE SET NULL,
  request_key TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  CHECK (end_at > start_at AND end_at <= start_at + interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS idx_evidence_clips_queue ON evidence_clips (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_evidence_clips_created ON evidence_clips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_event_time ON detection_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_notice_time ON surveillance_notifications (detected_at DESC);
CREATE TABLE IF NOT EXISTS evidence_reviews (
  id UUID PRIMARY KEY,
  event_id BIGINT UNIQUE REFERENCES detection_events(id) ON DELETE CASCADE,
  notice_id BIGINT UNIQUE REFERENCES surveillance_notifications(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('unreviewed','reviewed','important','false_positive')),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((event_id IS NOT NULL)::int + (notice_id IS NOT NULL)::int = 1)
);
