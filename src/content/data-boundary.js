export function allowSensitiveLocalData() {
  try {
    return ['127.0.0.1', 'localhost'].includes(location.hostname);
  } catch {
    return false;
  }
}
