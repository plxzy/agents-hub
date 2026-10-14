import assert from 'node:assert/strict';
import test from 'node:test';
process.env.AGENT_SUDO_ALLOW = JSON.stringify(['sudo -n /usr/local/sbin/netwatch-history ']);
const { verdict } = await import('./readonly-bash.ts');

test('blocks state changes, including the flush the model tried', () => {
  for (const c of ['sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder', 'killall Safari', 'rm -rf ~/x',
    'networksetup -setdnsservers Wi-Fi 1.1.1.1', 'mullvad disconnect', 'echo hi > ~/f', 'ls | tee out.txt',
    'sudo lsof -i', 'launchctl bootout gui/502/x', 'ifconfig en0 down', 'brew install foo'])
    assert.ok(verdict(c), `should block: ${c}`);
});

test('allows read-only commands and the allowed sudo helper', () => {
  for (const c of ['lsof -nP -i +c 0 2>/dev/null | head', 'nettop -P -L 1 -n -x', 'mullvad status', 'mullvad relay get',
    'scutil --dns | head -60', 'route -n get default', 'ifconfig -a', 'sudo -n /usr/local/sbin/netwatch-history log 5',
    '~/.agents/agent-skills/macos-networking/traffic.py 10', 'ping -c 3 1.1.1.1 >/dev/null 2>&1; echo $?', 'netstat -rn'])
    assert.equal(verdict(c), undefined, `should allow: ${c}`);
});
