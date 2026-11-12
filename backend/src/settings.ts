import { config } from './config';
import { pool } from './db';
import { ServerSettings, validateSettings } from './settingsValidation';
export { ServerSettings, validateSettings } from './settingsValidation';

export function currentSettings(): ServerSettings {
  return {
    public_base_url: config.publicBaseUrl,
    storage_label: config.storageLabel,
    record_retention_hours: config.recordRetentionHours,
    cleanup_threshold_percent: config.storageCleanupThresholdPercent,
    cleanup_target_percent: config.storageCleanupTargetPercent,
    cleanup_interval_minutes: config.storageCleanupIntervalMinutes,
  };
}

function applySettings(value: ServerSettings): void {
  config.publicBaseUrl = value.public_base_url;
  config.storageLabel = value.storage_label;
  config.recordRetentionHours = value.record_retention_hours;
  config.storageCleanupThresholdPercent = value.cleanup_threshold_percent;
  config.storageCleanupTargetPercent = value.cleanup_target_percent;
  config.storageCleanupIntervalMinutes = value.cleanup_interval_minutes;
}

export async function loadSettings(): Promise<void> {
  const { rows } = await pool.query('SELECT value FROM application_settings WHERE id = 1');
  if (rows[0]) applySettings(validateSettings(rows[0].value));
}

// Serialize writes so a delayed database response cannot apply an older policy.
let saveQueue: Promise<unknown> = Promise.resolve();
export function saveSettings(input: unknown, userId: number): Promise<ServerSettings> {
  const value = validateSettings(input);
  const save = saveQueue.then(async () => {
    await pool.query(
      'INSERT INTO application_settings (id, value, updated_by) VALUES (1, $1::jsonb, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()',
      [JSON.stringify(value), userId]
    );
    applySettings(value);
    return value;
  });
  saveQueue = save.catch(() => undefined);
  return save;
}
