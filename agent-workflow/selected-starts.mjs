// Durable client request identities. A repeated call reconciles; it never dispatches another start.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateSelectedStart, REQUEST_ID } from './run-selection.mjs';
import { hubStart, hubStartStatus } from './hub.mjs';
const dir = state => path.join(state, 'selected-starts');
const file = (state, id) => {
  if (!REQUEST_ID.test(id ?? '')) throw new Error('Invalid request identity');
  return path.join(dir(state), id + '.json');
};
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
function save(name, value, exclusive = false) {
  const target = name + '.' + randomUUID();
  fs.writeFileSync(target, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  if (exclusive) {
    try { fs.linkSync(target, name); } finally { fs.unlinkSync(target); }
  } else fs.renameSync(target, name);
  const fd = fs.openSync(path.dirname(name), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const visible = r => ({ request_id: r.request_id, runner: r.args.runner, agent: r.args.agent, task: r.args.task,
  created_at: r.created_at, state: r.state, run_id: r.run_id, status: r.status, message: r.message });
export function selectedStarts(state) {
  if (!fs.existsSync(dir(state))) return [];
  const all = fs.readdirSync(dir(state)).filter(n => n.endsWith('.json')).map(n => read(path.join(dir(state), n)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const recent = new Set(all.slice(-10));
  return all.filter(r => r.state === 'unknown' || recent.has(r)).map(visible);
}
export async function selectedStartStatus(id, options) {
  const name = file(options.state, id), r = read(name);
  if (r.state !== 'unknown') return visible(r);
  if (r.args.runner === 'dok') {
    try {
      const status = await hubStartStatus(id, options);
      if (status.state === 'started' && typeof status.run_id === 'string') Object.assign(r, status);
      else if (status.state === 'not_found') r.message = 'No dok journal entry is visible yet. This remains unresolved; do not submit a duplicate.';
      else r.message = 'Start remains unresolved. Check again; do not submit it as a new task.';
    } catch { r.message = 'Cannot reconcile the original start while the Hub is unavailable.'; }
  } else {
    const local = options.findLocal(r.planned_run_id);
    if (local) Object.assign(r, { state: 'started', run_id: local.run_id, status: local.status });
    else r.message = 'Local start remains unresolved. Inspect local run state before submitting another task.';
  }
  // A concurrent successful submit must win over an older lookup result.
  const latest = read(name);
  if (latest.state === 'started') return visible(latest);
  if (r.state === 'started') save(name, r);
  return visible(r);
}
export async function startSelected(args, options) {
  validateSelectedStart(args);
  const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
  const payloadFingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'request_id').sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
  const name = file(options.state, args.request_id);
  const existing = async () => {
    if (read(name).fingerprint !== fingerprint) throw new Error('Request identity belongs to a different task');
    return selectedStartStatus(args.request_id, options);
  };
  if (fs.existsSync(name)) return existing();
  if (fs.existsSync(dir(options.state))) {
    const unresolved = fs.readdirSync(dir(options.state)).filter(n => n.endsWith('.json')).map(n => read(path.join(dir(options.state), n)))
      .find(r => r.state === 'unknown' && r.payloadFingerprint === payloadFingerprint);
    if (unresolved) return selectedStartStatus(unresolved.request_id, options);
  }
  if (args.runner === 'mac') options.validateLocal(args);
  else if (!options.config) throw new Error('This Mac is not linked to the Hub. Select This Mac explicitly to run locally.');
  fs.mkdirSync(dir(options.state), { recursive: true, mode: 0o700 });
  const r = { request_id: args.request_id, args, fingerprint, payloadFingerprint, created_at: new Date().toISOString(), state: 'unknown',
    planned_run_id: args.runner === 'mac' ? options.newRunId() : undefined, message: 'Start awaiting confirmation.' };
  try { save(name, r, true); } catch (e) { if (e.code === 'EEXIST') return existing(); throw e; }
  try {
    const value = args.runner === 'dok'
      ? await hubStart({ agent: args.agent, task: args.task, request_id: args.request_id,
        ...(options.mcpConnection ? { mcp_connection: options.mcpConnection } : {}) }, options)
      : options.startLocal(args, r.planned_run_id);
    if (!value?.run_id) throw new Error('Start response missing run identity');
    Object.assign(r, { state: 'started', run_id: value.run_id, status: value.status, message: undefined });
  } catch (e) {
    // These HTTP errors precede dispatch. Transport failures and server errors are ambiguous.
    if (args.runner === 'dok' && [400, 401, 403, 404, 409].includes(e.status)) r.state = 'not_started';
    r.message = r.state === 'not_started' ? e.message : 'Start response unavailable. Check this original request before submitting another task.';
  }
  const latest = read(name);
  if (latest.state === 'started') return visible(latest);
  save(name, r); return visible(r);
}
