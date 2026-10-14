import assert from 'node:assert/strict';
import test from 'node:test';
process.env.AGENT_PROTECTED = JSON.stringify(['/h/.agents/agents/workflow.md', '/h/.agents/memory/shared', '/h/.agents/memory/agents']);
const { verdict, pathVerdict } = await import('./workspace-bash.ts');
const cwd = '/h/repo';

test('allows normal development work', () => {
  for (const c of ['node --test agent-workflow/', 'git add -A && git commit -m "x"', 'echo hi > notes.txt', 'rm -f tmp/out.json',
    'sed -i "" s/a/b/ agent.mjs', 'cd /h/.agents && git log --oneline | head', 'agent run network "is my VPN up?"', 'agent eval network',
    'mkdir -p /h/.agents/agent-skills/x', 'mullvad status', 'npm install', 'grep -rn process.env agent.mjs'])
    assert.equal(verdict(c, cwd), undefined, `should allow: ${c}`);
});

test('blocks the machine, history rewrites, user decisions and secrets', () => {
  for (const c of ['sudo ls', 'killall Finder', 'launchctl list', 'git push', 'git reset --hard HEAD~1', 'git clean -fd',
    'agent memory accept m-1', 'agent review accept i-1', 'agent feedback last good', 'cat ~/.codex/auth.json',
    'cat ~/.pi/agent/openai-accounts.json', 'security find-generic-password -s x', 'brew install jq', 'npm i -g foo',
    'codex mcp add x -- y', 'cat .env'])
    assert.ok(verdict(c, cwd), `should block: ${c}`);
});

test('protected paths cannot be changed from bash or edit/write, but can be read', () => {
  assert.ok(verdict('echo x >> /h/.agents/agents/workflow.md', cwd));
  assert.ok(verdict('cd /h/.agents/memory && rm shared/m-1.md', cwd));
  assert.ok(verdict('mv x /h/.agents/memory/agents/workflow/m.md', cwd));
  assert.equal(verdict('cat /h/.agents/agents/workflow.md', cwd), undefined);
  assert.ok(pathVerdict('edit', '/h/.agents/agents/workflow.md', cwd));
  assert.ok(pathVerdict('write', '../.agents/memory/shared/new.md', '/h/repo'));
  assert.equal(pathVerdict('read', '/h/.agents/agents/workflow.md', cwd), undefined);
  assert.equal(pathVerdict('edit', '/h/.agents/agents/network.md', cwd), undefined);
  assert.ok(pathVerdict('read', '/Users/x/.codex/auth.json', cwd));
});
