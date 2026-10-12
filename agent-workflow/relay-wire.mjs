// Shared browser/Worker/Node transport rules; no machine credentials or runtime imports.
export const WIRE = Object.freeze({ version: 1, handshake: 10000, attempt: 20000, capacity: 32,
  messageBytes: 262144, resultBytes: 230000, keepalive: 10000, freshness: 30000, retention: 300000 });
export const PING = 'agents-hub:ping:1';
export const PONG = 'agents-hub:pong:1';
export const bytes = (text) => new TextEncoder().encode(text).byteLength;
export function encode(value, limit = WIRE.messageBytes) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || bytes(text) > limit) throw new Error('Relay message too large');
  return text;
}
export function decode(text) {
  if (typeof text !== 'string' || bytes(text) > WIRE.messageBytes) throw new Error('Invalid relay message');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== WIRE.version) throw new Error('Invalid relay protocol');
  return value;
}
export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id);
export function validateStatus(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.agents) || value.agents.length > 100
    || value.agents.some((s) => typeof s !== 'string' || s.length > 100)) throw new Error('Invalid relay status');
  let selection;
  if (value.run_selection !== undefined) {
    const s = value.run_selection;
    if (s?.version !== 1 || !Array.isArray(s.agents) || s.agents.length > 100) throw new Error('Invalid runner selection status');
    selection = { version: 1, agents: s.agents.map(a => {
      if (!a || !value.agents.includes(a.name)) throw new Error('Invalid runner selection agent');
      const out = { name: a.name };
      for (const k of ['model', 'repo', 'reason']) if (a[k] !== undefined) {
        if (typeof a[k] !== 'string' || a[k].length > 300) throw new Error('Invalid runner selection field');
        out[k] = a[k];
      }
      return out;
    }) };
  }
  return { enabled: value.enabled, agents: value.agents, ...(selection ? { run_selection: selection } : {}) };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export function fingerprintText(operation, args) {
  const { request_id, confirm, ...semantic } = args;
  return 'v2\n' + operation + '\n' + JSON.stringify(canonical(semantic));
}
export async function fingerprint(operation, args) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprintText(operation, args)));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
