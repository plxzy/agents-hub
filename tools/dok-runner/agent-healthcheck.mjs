#!/usr/local/bin/node
import fs from 'node:fs';
import path from 'node:path';

const configFile = process.argv[2] ?? '/home/agent/.config/agent-workflow/dok.json';
const freshnessMs = 30000;

function fail(reason) {
  console.error(`agent healthcheck: ${reason}`);
  process.exitCode = 1;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function processStart(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return text.split(') ').at(-1).split(' ')[19] ?? null;
  } catch { return null; }
}

function validTimestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now && now - time < freshnessMs;
}

const config = readJson(configFile);
if (!config || typeof config.state !== 'string' || !path.isAbsolute(config.state)) fail('supervisor configuration unavailable');
else {
  const state = path.resolve(config.state);
  const pidFile = readJson(path.join(state, 'supervisor.json'));
  const health = readJson(path.join(state, 'supervisor-health.json'));
  const now = Date.now();
  if (!pidFile || !Number.isInteger(pidFile.pid) || typeof pidFile.started !== 'string') fail('supervisor identity unavailable');
  else if (processStart(pidFile.pid) !== pidFile.started) fail('supervisor is not the recorded process');
  else {
    let command = '';
    try { command = fs.readFileSync(`/proc/${pidFile.pid}/cmdline`, 'utf8'); } catch { /* identity check above is authoritative */ }
    if (!command.includes('dev-supervisor.mjs')) fail('recorded process is not the supervisor');
    else if (!health || health.schema_version !== 1 || health.pid !== pidFile.pid || health.started !== pidFile.started
      || typeof health.process_session !== 'string' || health.process_session !== pidFile.process_session) fail('supervisor heartbeat identity mismatch');
    else if (health.hub_ready !== true || health.fatal === true) fail('Hub relay is not ready');
    else if (!validTimestamp(health.last_pong_at, now)) fail('Hub pong is missing or stale');
    else if (!validTimestamp(health.updated_at, now)) fail('supervisor heartbeat is stale');
    else process.exitCode = 0;
  }
}
