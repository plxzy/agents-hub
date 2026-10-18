// Pure wire contract for supervisor-owned VM worker control (plxzy/vm docs/AGENTS-HUB-VMSERVICE-CONTRACT.md, #806).
// Strict request/reply validation, the closed action table and the response projection. No I/O, no credential.

export const FORMAT = 1;
// The bounds of the contract. Injected limits may only be tighter than these.
export const LIMITS = Object.freeze({ polls: 3, pollGapMs: 5000, helperMs: 65000, batchMs: 210000, lineBytes: 64 * 1024, stdoutBytes: 8 * 1024 * 1024 });
// Closed table: `${target}:${operation}` -> the existing control-worker action. Backing restart is deliberately absent.
export const ACTIONS = Object.freeze({ 'backing:start': 'backing-start', 'backing:stop': 'backing-stop',
  'browser:start': 'browser-resume', 'browser:stop': 'browser-stop', 'browser:restart': 'browser-restart' });
export const STATES = Object.freeze(['confirmed', 'refused', 'unknown', 'absent']);

export class ContractError extends Error {
  constructor(code, detail) { super(detail); this.code = code; this.detail = detail; }
}
const bad = detail => new ContractError('bad-request', detail);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (v, keys) => { const k = Object.keys(v); return k.length === keys.length && keys.every(x => Object.hasOwn(v, x)); };

/** JSON.parse that rejects duplicate member names, trailing bytes and anything outside the JSON grammar. */
export function parseStrictJson(text, code = 'bad-request') {
  let i = 0;
  const fail = detail => { throw new ContractError(code, detail); };
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('not JSON: unterminated string');
    i++;
    try { return JSON.parse(text.slice(start, i)); } catch { return fail('not JSON: bad string'); }
  };
  const value = depth => {
    if (depth > 32) fail('not JSON: nested too deeply');
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      const entries = [], seen = new Set();
      if (text[i] === '}') { i++; return {}; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('not JSON: expected a member name');
        const key = string();
        if (seen.has(key)) fail('duplicate JSON member name');
        seen.add(key); ws();
        if (text[i++] !== ':') fail('not JSON: expected ":"');
        entries.push([key, value(depth + 1)]); ws();
        const d = text[i++];
        if (d === '}') break;
        if (d !== ',') fail('not JSON: expected "," or "}"');
      }
      return Object.fromEntries(entries);
    }
    if (c === '[') {
      i++; ws();
      const items = [];
      if (text[i] === ']') { i++; return items; }
      for (;;) {
        items.push(value(depth + 1)); ws();
        const d = text[i++];
        if (d === ']') break;
        if (d !== ',') fail('not JSON: expected "," or "]"');
      }
      return items;
    }
    if (c === '"') return string();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(word, i)) { i += word.length; return v; }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    number.lastIndex = i;
    const m = number.exec(text);
    if (!m) fail('not JSON: unexpected token');
    i += m[0].length;
    return Number(m[0]);
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail('not JSON: trailing bytes');
  return result;
}

const REQUEST_KEYS = ['format', 'kind', 'operation', 'target', 'hostId', 'service', 'projectId', 'worker', 'workerGeneration', 'backingId', 'mutationId'];
export const INTENT_KEYS = REQUEST_KEYS.filter(k => k !== 'kind' && k !== 'mutationId');
const ID_FIELDS = ['hostId', 'service', 'projectId', 'worker', 'workerGeneration', 'mutationId'];
const isId = v => typeof v === 'string' && v.length >= 1 && v.length <= 200;
const isBacking = v => v === null || (typeof v === 'string' && /^[0-9a-f]{12,64}$/.test(v));
export const actionFor = (target, operation) => ACTIONS[`${target}:${operation}`];

function checkFields(v, keys) {
  if (!plain(v)) throw bad('a request is a JSON object');
  const missing = keys.filter(k => !Object.hasOwn(v, k));
  if (missing.length) throw bad(`missing member ${missing[0]}`);
  const extra = Object.keys(v).filter(k => !keys.includes(k));
  if (extra.length) throw bad('the request carries a member this boundary does not take');
  if (v.format !== FORMAT) throw bad('format must be 1');
  if (!['start', 'stop', 'restart'].includes(v.operation)) throw bad('operation is start, stop or restart');
  if (!['backing', 'browser'].includes(v.target)) throw bad('target is backing or browser');
  if (!actionFor(v.target, v.operation)) throw bad('this target does not admit that operation');
  for (const k of ID_FIELDS) if (Object.hasOwn(v, k) && !isId(v[k])) throw bad(`${k} is a 1..200 character string`);
  // Missing was rejected above; explicit null is the distinct "service observed no backing" identity.
  if (!isBacking(v.backingId)) throw bad('backingId is null or a 12..64 character lowercase hex engine id');
}
/** The full supervisor/Hub request (either kind). Returns a frozen copy in canonical member order. */
export function validateRequest(value) {
  checkFields(value, REQUEST_KEYS);
  if (!['control', 'receipt'].includes(value.kind)) throw bad('kind is control or receipt');
  return Object.freeze(Object.fromEntries(REQUEST_KEYS.map(k => [k, value[k]])));
}
/** What a caller may submit: the request without `kind` and without `mutationId`, which only the supervisor mints. */
export function validateIntent(value) {
  checkFields(value, INTENT_KEYS);
  return Object.freeze(Object.fromEntries(INTENT_KEYS.map(k => [k, value[k]])));
}
export const intentOf = request => validateIntent(Object.fromEntries(INTENT_KEYS.map(k => [k, request[k]])));
export const receiptRequest = request => validateRequest({ ...request, kind: 'receipt' });

/** The daemon's `body` for one request: exactly the six members, in the contract's order. */
export function daemonBody(request) {
  return { operation: request.kind === 'control' ? 'control-worker' : 'get-control-receipt', action: actionFor(request.target, request.operation),
    worker: request.worker, workerGeneration: request.workerGeneration, backingId: request.backingId, mutationId: request.mutationId };
}
export const statusBody = () => ({ operation: 'status' });
/** The one UTF-8 JSON line (with trailing newline) the door writes to the helper's stdin. */
export function envelopeLine(authorization, body) {
  const line = JSON.stringify({ authorization, route: 'call', body }) + '\n';
  if (Buffer.byteLength(line) > LIMITS.lineBytes) throw bad(`the request line is over ${LIMITS.lineBytes} bytes`);
  return line;
}

const RECEIPT_KEYS = ['format', 'serviceId', 'worker', 'workerGeneration', 'backingId', 'action', 'mutationId', 'state', 'detail'];
const RECEIPT_OPTIONAL = ['replayed', 'reconciled', 'backing', 'decision'];
const reply = detail => new ContractError('reply-invalid', detail);
function checkReceipt(r) {
  if (!plain(r)) throw reply('result is not an object');
  for (const k of RECEIPT_KEYS) if (!Object.hasOwn(r, k)) throw reply(`receipt lacks ${k}`);
  if (Object.keys(r).some(k => !RECEIPT_KEYS.includes(k) && !RECEIPT_OPTIONAL.includes(k))) throw reply('receipt carries an unknown member');
  if (r.format !== FORMAT) throw reply('receipt format is not 1');
  for (const k of ['serviceId', 'worker', 'workerGeneration']) if (typeof r[k] !== 'string' || !r[k]) throw reply(`receipt ${k} is invalid`);
  if (!isBacking(r.backingId)) throw reply('receipt backingId is invalid');
  if (!Object.values(ACTIONS).includes(r.action)) throw reply('receipt action is not admitted');
  if (!isId(r.mutationId)) throw reply('receipt mutationId is invalid');
  if (!STATES.includes(r.state)) throw reply('receipt state is not recognised');
  if (typeof r.detail !== 'string') throw reply('receipt detail is invalid');
  for (const k of ['replayed', 'reconciled']) if (Object.hasOwn(r, k) && typeof r[k] !== 'boolean') throw reply(`receipt ${k} is invalid`);
  for (const k of ['backing', 'decision']) if (Object.hasOwn(r, k) && !plain(r[k])) throw reply(`receipt ${k} is invalid`);
}
const errorObject = e => plain(e) && sameKeys(e, ['code', 'detail']) && typeof e.code === 'string' && e.code && typeof e.detail === 'string';

/** Parse the helper's whole stdout: exactly one complete reply line, nothing else. Throws ContractError('reply-invalid'). */
export function parseReply(bytes, kind = 'receipt') {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw reply('reply is not UTF-8'); }
  const end = text.indexOf('\n');
  if (end < 0) throw reply('reply is incomplete: no terminating newline');
  if (text.slice(end).trim() !== '') throw reply('reply carries more than one line');
  let value;
  try { value = parseStrictJson(text.slice(0, end), 'reply-invalid'); } catch (e) { throw reply(e.detail ?? 'reply is not JSON'); }
  if (!plain(value) || !Number.isInteger(value.status)) throw reply('reply has no integer status');
  if (value.status === 200) {
    if (!sameKeys(value, ['status', 'result'])) throw reply('a 200 reply is exactly status and result');
    if (kind === 'receipt') checkReceipt(value.result);
    else if (!plain(value.result)) throw reply('status result is not an object');
    return value;
  }
  if (value.status < 400 || value.status > 599 || !sameKeys(value, ['status', 'error']) || !errorObject(value.error)) throw reply('malformed error reply');
  return value;
}
/** The enrolled service's identity from a `status` reply, or throws. */
export function statusServiceId(parsed) {
  if (parsed.status !== 200) throw reply('status was not answered');
  const id = parsed.result?.serviceId;
  if (!plain(parsed.result) || typeof id !== 'string' || !id) throw reply('status carries no serviceId');
  return id;
}
/** Every receipt identity field and the action must equal the frozen request; a mismatch is a protocol failure. */
export function verifyReceipt(request, parsed) {
  if (parsed.status !== 200) return;
  const r = parsed.result;
  const same = r.serviceId === request.service && r.worker === request.worker && r.workerGeneration === request.workerGeneration
    && r.backingId === request.backingId && r.action === actionFor(request.target, request.operation) && r.mutationId === request.mutationId;
  if (!same) throw new ContractError('identity-mismatch', 'reply identity does not equal the frozen request');
}

/** Outcome of one exchange: {kind:'reply', reply} | {kind:'transport', detail} | {kind:'admission', code, detail}. */
export function projectOutcome(request, outcome) {
  const base = { format: FORMAT, request };
  // Contract: `request` is null ONLY for an admission refusal of a new control submission (no mutationId exists before
  // authorization); every other projection, including an admission refusal of a receipt read, carries the full request.
  if (outcome.kind === 'admission') return { ...base, state: 'refused', source: 'admission', reply: null, error: { code: outcome.code, detail: outcome.detail } };
  if (outcome.kind === 'transport') return { ...base, state: 'unknown', source: 'transport', reply: null, error: { code: 'reply-unavailable', detail: outcome.detail } };
  const r = outcome.reply;
  // A valid result projects its state verbatim; a 4xx is a definite door/service refusal; 5xx is not trustworthy evidence.
  const state = r.status === 200 ? r.result.state : r.status < 500 ? 'refused' : 'unknown';
  return { ...base, state, source: 'service-door', reply: r, error: null };
}
/** A settled outcome the supervisor must never replace or re-dispatch. */
export const isDefinite = response => response.source === 'service-door' && (response.state === 'confirmed' || response.state === 'refused');
