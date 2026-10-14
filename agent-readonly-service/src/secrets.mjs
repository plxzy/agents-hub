// Shared check for values that must never be stored or shown: receipts, memory notes and agent definitions use it.
const SECRET_FIELD = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|private[_-]?key|secret|signed[_-]?url)/i;
const SECRET_VALUE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|private[_-]?key|secret|signed[_-]?url)\s*[:=]|\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}/i;

/** True when a value (or any nested key/value) looks like it carries a secret. */
export function containsSecret(value) {
  if (typeof value === 'string') return SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => SECRET_FIELD.test(key) || containsSecret(child));
}
