// Model-account cooldowns shared by all runners. A slot is an account id such as openai or openai-2.
const SLOT = /^openai(-[1-9]\d*)?$/;
const STATES = ['ok', 'cooldown', 'disabled'];
const KINDS = ['usage limit reached', 'account not eligible', 'model authentication failed', 'cleared'];

export async function readAccounts(env) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare('SELECT slot, state, until, last_error_kind, host, updated_at FROM accounts ORDER BY slot').all();
    const now = Date.now();
    // An elapsed cooldown or disable is reported as ok; the row stays as history until overwritten.
    return results.map((r) => ({ ...r, state: r.state !== 'ok' && r.until && Date.parse(r.until) <= now ? 'ok' : r.state }));
  } catch { return []; }
}

export async function recordAccount(env, value, host) {
  if (!value || !SLOT.test(value.slot ?? '') || !STATES.includes(value.state) || (value.last_error_kind && !KINDS.includes(value.last_error_kind))
    || (value.until && (typeof value.until !== 'string' || Number.isNaN(Date.parse(value.until))))) throw new Error('Invalid account state');
  await env.DB.prepare(`INSERT INTO accounts (slot, state, until, last_error_kind, host, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET state=excluded.state, until=excluded.until, last_error_kind=excluded.last_error_kind, host=excluded.host, updated_at=excluded.updated_at`)
    .bind(value.slot, value.state, value.until ?? null, value.last_error_kind ?? null, host, new Date().toISOString()).run();
}
