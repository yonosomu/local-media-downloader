import type { ErrorCode, SafeError } from './contracts';
const messages: Record<ErrorCode, string> = {
  PERMISSION_REQUIRED: 'Нужно разрешение на источник или CDN.', AUTH_REQUIRED: 'Требуется вход на сайте.', URL_EXPIRED: 'Ссылка истекла. Обнаружите источник заново.',
  NETWORK_TIMEOUT: 'Превышено время ожидания сети.', NETWORK_OFFLINE: 'Сеть недоступна.', HTTP_ERROR: 'Сервер вернул ошибку.', RATE_LIMITED: 'Сервер ограничил частоту запросов.',
  INVALID_MANIFEST: 'Манифест повреждён или некорректен.', MANIFEST_LIMIT: 'Превышены безопасные пределы манифеста.', UNSUPPORTED_FORMAT: 'Профиль медиа не поддерживается.',
  ENCRYPTED_UNSUPPORTED: 'Зашифрованный поток не поддерживается.', DRM_UNSUPPORTED: 'Поток защищён DRM.', SEGMENT_MISSING: 'Сегмент отсутствует; возможен разрыв потока.',
  RESOURCE_CHANGED: 'Источник изменился. Требуется новая загрузка.', QUOTA_EXCEEDED: 'Недостаточно места во временном хранилище.', DISK_WRITE_FAILED: 'Не удалось записать файл.',
  MUX_FAILED: 'Не удалось собрать воспроизводимый файл.', EXPORT_CANCELLED: 'Сохранение отменено.', BROWSER_UNSUPPORTED: 'Браузер не поддерживает необходимый API.',
  SOURCE_TAB_REQUIRED: 'Для источника нужна открытая вкладка.', INVALID_REQUEST: 'Некорректная команда.', INVALID_STATE: 'Действие недоступно в текущем состоянии.',
};
export class EngineError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryable = false) { super(messages[code]); this.name = 'EngineError'; }
}
export function safeError(error: unknown): SafeError {
  const code = error instanceof EngineError ? error.code : error instanceof DOMException && error.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : error instanceof Error && Object.hasOwn(messages, error.message) ? error.message as ErrorCode : 'MUX_FAILED';
  return { code, message: messages[code], retryable: error instanceof EngineError && error.retryable };
}
export function fail(code: ErrorCode): never { throw new EngineError(code); }
