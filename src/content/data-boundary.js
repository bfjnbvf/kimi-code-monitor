import { DEFAULT_WEB_PORT } from '../host-patterns.js';

export function allowSensitiveLocalData() {
  try {
    return location.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(location.hostname) &&
      location.port === String(DEFAULT_WEB_PORT);
  } catch {
    return false;
  }
}
