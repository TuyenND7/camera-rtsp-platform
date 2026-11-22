-- Operating mode changes policy only; recording and RTSP transports are untouched.
CREATE TABLE IF NOT EXISTS operating_profile_settings (
  id SMALLINT PRIMARY KEY CHECK (id=1), value JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS operating_profile_runtime (
  id SMALLINT PRIMARY KEY CHECK (id=1), mode TEXT NOT NULL, source TEXT NOT NULL,
  camera_overrides JSONB NOT NULL DEFAULT '{}'::jsonb, notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  settings_revision INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true, timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  quiet_enabled BOOLEAN NOT NULL DEFAULT false, quiet_start TEXT NOT NULL DEFAULT '22:00', quiet_end TEXT NOT NULL DEFAULT '07:00',
  snooze_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL, keys JSONB NOT NULL, name TEXT NOT NULL,
  cursor_id BIGINT NOT NULL DEFAULT 0, last_success_at TIMESTAMPTZ, last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session ON push_subscriptions(session_hash);
CREATE TABLE IF NOT EXISTS push_deliveries (
  id BIGSERIAL PRIMARY KEY, subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  notification_id BIGINT NOT NULL REFERENCES surveillance_notifications(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','skipped','failed')),
  attempts SMALLINT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subscription_id,notification_id)
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_due ON push_deliveries(next_attempt_at) WHERE state IN ('pending','sending');
CREATE INDEX IF NOT EXISTS idx_notifications_push_window ON surveillance_notifications(created_at,id);
