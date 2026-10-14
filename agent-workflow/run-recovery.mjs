// Trusted private runner journal. Never mounted into the agent's tool sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { save, read, syncFile, syncDirectory } from './durable-file.mjs';

export const SAFE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'session_runtime']);
export const RECOVERY_SCHEMA = 1;
export const MAX_CHECKPOINT_BYTES = 16 * 1024 ** 2;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secret = /sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+\S+|-----BEGIN[^\n]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\./;
export function privateResult(value) {
  const text = JSON.stringify(value);
  if (text.length > 2 * 1024 ** 2) throw Error('Recovery result exceeds storage budget');
  return secret.test(text) ? { content: [{ type: 'text', text: '[redacted: result resembled a credential]' }] } : value;
}
export function loadCheckpoint(file) {
  if (fs.statSync(file).size > MAX_CHECKPOINT_BYTES) throw Error('Recovery checkpoint exceeds storage budget');
  const v = read(file);
  if (v.schema !== RECOVERY_SCHEMA || !Number.isSafeInteger(v.version) || v.version < 1 || !v.tools || typeof v.tools !== 'object'
    || !Number.isFinite(v.remaining_ms) || v.remaining_ms < 0) throw Error('Recovery checkpoint is invalid');
  return v;
}
export function recoveryState(v) {
  if (Object.values(v.tools).some(t => t.state === 'started' && !SAFE_TOOLS.has(t.name))) return 'awaiting_review';
  return 'ready';
}

// One child writes each checkpoint. The supervisor reads it only after that child has stopped.
export class RunJournal {
  constructor(file, { remainingMs, previous, now = Date.now } = {}) {
    this.file = file; this.now = now; this.last = now();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.value = previous ? structuredClone(previous) : { schema: RECOVERY_SCHEMA, version: 0, tools: {}, remaining_ms: remainingMs };
    if (previous && Number.isFinite(remainingMs)) this.value.remaining_ms = Math.min(this.value.remaining_ms, remainingMs);
    this.value.result = undefined;
    this.update({});
  }
  update(patch) {
    const now = this.now();
    this.value = { ...this.value, ...patch, remaining_ms: Math.max(0, Math.min(this.value.remaining_ms, patch.remaining_ms ?? Infinity) - Math.max(0, now - this.last)),
      version: this.value.version + 1, saved_at: new Date(now).toISOString() };
    this.last = now;
    if (Buffer.byteLength(JSON.stringify(this.value)) > MAX_CHECKPOINT_BYTES) throw Error('Recovery checkpoint exceeds storage budget');
    save(this.file, this.value);
    return this.value;
  }
  session(manager) {
    const file = manager?.getSessionFile?.();
    if (file && fs.existsSync(file)) { syncFile(file); syncDirectory(path.dirname(file)); }
    this.update(file ? { session_file: file } : {});
  }
  async tool(id, name, args, execute, manager, flushWorkspace) {
    if (typeof id !== 'string' || !id || id.length > 512) throw Error('Tool call identity unavailable');
    const key = fingerprint(id), identity = fingerprint({ name, args }), old = this.value.tools[key];
    if (old && old.fingerprint !== identity) throw Error('Recovery tool identity conflict');
    if (old?.state === 'completed') return old.result;
    if (old?.state === 'started' && !SAFE_TOOLS.has(name)) throw Error('Interrupted command requires recovery review');
    if (this.value.remaining_ms <= 0) throw Error('Run execution budget exhausted');
    this.session(manager); // the model's tool call is on disk before its effects can occur
    this.value.tools[key] = { id, name, fingerprint: identity, state: 'started' };
    this.update({});
    // Exceptions leave the intent unresolved: a failed shell may have already changed files.
    const result = privateResult(await execute());
    if (!SAFE_TOOLS.has(name)) await flushWorkspace?.(); // effects must survive power loss before completion is acknowledged
    this.value.tools[key] = { ...this.value.tools[key], state: 'completed', result };
    this.update({}); // result is durable before the model receives it
    return result;
  }
  finish(result, manager) { this.session(manager); this.update({ result: privateResult(result) }); }
}

// Reconcile a saved assistant tool batch before sending any new prompt. This is deliberately
// enforced by the harness, not delegated to the model's interpretation of an interruption.
export async function reconcileSession(manager, journal, tools, { approved = false } = {}) {
  const messages = manager.buildSessionContext().messages;
  const results = new Set(messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId));
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of (message.content ?? []).filter(c => c.type === 'toolCall' && !results.has(c.id))) {
      const entry = journal.value.tools[fingerprint(call.id)];
      let result, isError = false;
      if (entry?.state === 'completed') { result = entry.result; isError = entry.reconciled === true; }
      else if (entry?.state === 'started' && !SAFE_TOOLS.has(entry.name)) {
        if (!approved) throw Error('Interrupted command requires recovery review');
        result = { content: [{ type: 'text', text: 'This command was interrupted and may have partially executed. The user approved continuing from the inspected current files. Inspect before making further changes; this command was not replayed.' }] };
        isError = true;
        journal.value.tools[fingerprint(call.id)] = { ...entry, state: 'completed', result, reconciled: true };
        journal.update({});
      } else {
        const tool = tools.find(t => t.name === call.name);
        if (!tool) throw Error('Recovery tool unavailable');
        result = await tool.execute(call.id, call.arguments, new AbortController().signal);
      }
      manager.appendMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: result.content, details: result.details, isError, timestamp: Date.now() });
      journal.session(manager); results.add(call.id);
    }
  }
  return manager.buildSessionContext().messages;
}
