// Agent definitions, skills and evals held in D1. The user's git (~/.agents) is the only writer (`agent sync push`);
// a push is refused unless the Hub still holds the revision the pusher last published (no silent overwrites).
import { containsSecret } from './secrets.mjs';
import { acceptedMemory } from './memory.mjs';

const NAME = '[a-z0-9][a-z0-9_-]{0,63}';
const ALLOWED = [new RegExp(`^agents/${NAME}\\.md$`), new RegExp(`^agent-skills/${NAME}/[A-Za-z0-9._-]{1,100}(/[A-Za-z0-9._-]{1,100}){0,3}\\.(md|py|json|txt)$`),
  new RegExp(`^evals/${NAME}/[A-Za-z0-9._-]{1,100}\\.md$`)];
const MAX_FILE = 60_000, MAX_FILES = 400, MAX_TOTAL = 800_000;
export const validPath = (p) => typeof p === 'string' && !p.includes('..') && ALLOWED.some((re) => re.test(p));

async function sha(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function knowledgeRevision(env) {
  try { return (await env.DB.prepare("SELECT value FROM knowledge_state WHERE key = 'revision'").first())?.value ?? null; } catch { return null; }
}

/** One push. `base` is the revision the pusher last published (null on the first push); `files` is the full allowed set. */
export async function publishKnowledge(env, { revision, base, files }) {
  if (!/^[a-f0-9]{7,64}$/.test(revision ?? '') || !files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Invalid push');
  const held = await knowledgeRevision(env);
  if (held && held !== revision && base !== held) throw new Error(`The Hub holds ${held.slice(0, 12)}, which this push does not build on. Run agent sync pull first, or push from the checkout that published it.`);
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES || entries.reduce((n, [, c]) => n + (typeof c === 'string' ? c.length : MAX_TOTAL), 0) > MAX_TOTAL) throw new Error('Push too large');
  for (const [path, content] of entries) {
    if (!validPath(path) || typeof content !== 'string' || content.length > MAX_FILE || containsSecret(content)) throw new Error(`Refused file ${String(path).slice(0, 80)}`);
  }
  const now = new Date().toISOString(), keep = new Set(entries.map(([p]) => p));
  const stale = (await env.DB.prepare('SELECT path FROM knowledge_files').all()).results.map((r) => r.path).filter((p) => !keep.has(p));
  const statements = [];
  for (const [path, content] of entries) {
    statements.push(env.DB.prepare(`INSERT INTO knowledge_files (path, sha256, content, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, content = excluded.content, updated_at = excluded.updated_at WHERE knowledge_files.sha256 <> excluded.sha256`)
      .bind(path, await sha(content), content, now));
  }
  for (const path of stale) statements.push(env.DB.prepare('DELETE FROM knowledge_files WHERE path = ?').bind(path));
  statements.push(env.DB.prepare("INSERT INTO knowledge_state (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(revision));
  await env.DB.batch(statements);
  return { revision, files: entries.length, removed: stale.length };
}

export async function readFiles(env, prefixLike) {
  const { results } = await env.DB.prepare('SELECT path, content FROM knowledge_files WHERE path LIKE ? ORDER BY path').bind(prefixLike).all();
  return Object.fromEntries(results.map((r) => [r.path, r.content]));
}

// Minimal frontmatter reader (the Worker cannot use the CLI's): key: value lines between the --- fences.
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text ?? '');
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const kv = /^([a-z_]+):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].trim(); }
  return meta;
}
const list = (v) => (typeof v === 'string' && v ? v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean) : []);

/** Agent summaries in the shape the dashboard and list_agents read, built from the published definitions. */
export async function agentSummaries(env) {
  try {
    const files = await readFiles(env, 'agents/%');
    return Object.values(files).map((text) => {
      const m = frontmatter(text);
      return { name: m.name, description: m.description ?? '', model: m.model ?? null, tools: list(m.tools), skills: m.skills === 'none' ? 'none' : list(m.skills),
        guard: m.guard ?? null, workspace: m.workspace ?? null, runner: m.runner ?? 'local' };
    }).filter((a) => a.name);
  } catch { return []; }
}

/** Everything a run of one agent needs: its definition, the skills it names, accepted memory for its scopes, and a hash. */
export async function agentBundle(env, name) {
  if (!new RegExp(`^${NAME}$`).test(name ?? '')) throw new Error('Invalid agent');
  const definition = (await env.DB.prepare('SELECT content FROM knowledge_files WHERE path = ?').bind(`agents/${name}.md`).first())?.content;
  if (!definition) throw new Error('Unknown agent');
  const m = frontmatter(definition), skills = m.skills === 'none' ? [] : list(m.skills).filter((s) => new RegExp(`^${NAME}$`).test(s));
  const files = { [`agents/${name}.md`]: definition };
  for (const skill of skills) Object.assign(files, await readFiles(env, `agent-skills/${skill}/%`));
  const scopes = m.memory_scopes ? list(m.memory_scopes) : [`agent:${name}`];
  const memory = await acceptedMemory(env, scopes);
  return { revision: await knowledgeRevision(env), files, memory, hash: (await sha(JSON.stringify([files, memory]))).slice(0, 16) };
}
