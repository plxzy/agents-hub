// One-shot local observations. No network, lock probing, publication, timers or mutation APIs.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { healthOf, healthTime } from './health.mjs';

export function doctorHealth({ readConfig, state, journal = path.join(homedir(), '.config/agent-readonly/relay-journal'), sandboxed = process.env.AGENT_SANDBOXED === '1', now = Date.now() } = {}) {
  const data = { versions: { node: process.version }, configuration: { source: 'unavailable' }, history_limitation: 'relay journal unavailable' };
  // Never try to access the protected credential-bearing configuration from a sandboxed agent.
  if (!sandboxed && readConfig) {
    try { const c = readConfig(); data.configuration = { enabled: c.enabled, agents: c.agents, source: 'local configuration (not live relay status)' }; }
    catch { data.configuration.source = 'local configuration unavailable'; }
  } else if (sandboxed) data.configuration.source = 'sandbox protects private configuration';
  if (!sandboxed && state && journal) {
    try {
      const found = [];
      for (const file of fs.readdirSync(path.join(journal, 'runs'))) {
        if (!/^r-[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
        const runId = file.slice(0, -5);
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(journal, 'runs', file), 'utf8'));
          if (!/^[a-zA-Z0-9_-]{8,80}$/.test(marker.request_id)) continue;
          const dispatch = JSON.parse(fs.readFileSync(path.join(journal, marker.request_id + '.json'), 'utf8'));
          if (dispatch.state !== 'done' || dispatch.value?.run_id !== runId) continue;
          const receipt = JSON.parse(fs.readFileSync(path.join(state, 'runs', file), 'utf8'));
          const ended = healthTime(receipt.ended, now);
          if (receipt.run_id === runId && receipt.status === 'completed' && ended.at) found.push({ run_id: runId, ended: ended.at, origin: 'relay-journal' });
        } catch { /* A missing, malformed or incomplete receipt is not successful origin evidence. */ }
      }
      data.last_successful_relay_run = found.sort((a, b) => a.ended.localeCompare(b.ended)).at(-1);
      data.history_limitation = 'no journal-backed successful completion with a valid timestamp found';
    } catch { /* Report unavailable instead of manufacturing empty history. */ }
  } else if (sandboxed) data.history_limitation = 'sandbox protects the relay journal; origin cannot be established';
  return healthOf(data, { now });
}

/** Imported observation files are historical inputs; healthOf rechecks their timestamps at the current time. */
export function doctorInput(file, { now = Date.now() } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Health observation file exceeds 1 MiB');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a raw get_status/open_dashboard JSON object');
  // An input file cannot attest a private journal; only the local collector may establish origin.
  return healthOf({ relay: data.relay, snapshot: data.snapshot, capabilities: data.capabilities,
    relay_source: data.relay ? 'imported status/dashboard observation (not refreshed)' : 'unavailable' }, { now });
}
