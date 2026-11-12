export interface ServerSettings {
  public_base_url: string;
  storage_label: string;
  record_retention_hours: number;
  cleanup_threshold_percent: number;
  cleanup_target_percent: number;
  cleanup_interval_minutes: number;
}

export function validateSettings(input: unknown): ServerSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cấu hình không hợp lệ.');
  const value = input as Record<string, unknown>;
  const keys = ['public_base_url', 'storage_label', 'record_retention_hours', 'cleanup_threshold_percent', 'cleanup_target_percent', 'cleanup_interval_minutes'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('Cấu hình thiếu trường hoặc chứa trường không được phép.');
  if (typeof value.storage_label !== 'string' || !value.storage_label.trim() || value.storage_label.trim().length > 100) throw new Error('Tên ổ lưu trữ cần từ 1 đến 100 ký tự.');
  if (typeof value.public_base_url !== 'string' || value.public_base_url.length > 2048) throw new Error('Địa chỉ máy chủ không hợp lệ.');
  let baseUrl = value.public_base_url.trim();
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      baseUrl = url.origin;
    } catch { throw new Error('Địa chỉ máy chủ phải là HTTP/HTTPS, không chứa tài khoản hay mật khẩu.'); }
  }
  const number = (key: string, min: number, max: number): number => {
    const item = value[key];
    const labels: Record<string, string> = { record_retention_hours: 'Thời gian giữ bản ghi', cleanup_threshold_percent: 'Ngưỡng bắt đầu dọn', cleanup_target_percent: 'Mức dung lượng sau khi dọn', cleanup_interval_minutes: 'Chu kỳ kiểm tra' };
    if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) throw new Error(`${labels[key]} cần là số nguyên từ ${min} đến ${max}.`);
    return item;
  };
  const threshold = number('cleanup_threshold_percent', 1, 99);
  const target = number('cleanup_target_percent', 0, 98);
  if (target >= threshold) throw new Error('Mức dung lượng sau khi dọn phải thấp hơn ngưỡng bắt đầu dọn.');
  return {
    public_base_url: baseUrl,
    storage_label: value.storage_label.trim(),
    record_retention_hours: number('record_retention_hours', 0, 87600),
    cleanup_threshold_percent: threshold,
    cleanup_target_percent: target,
    cleanup_interval_minutes: number('cleanup_interval_minutes', 1, 1440),
  };
}
