import { expect, test } from 'claude-code/testing'

const DASHBOARD = {
  runner_selection: 1,
  run_targets: [
    { id: 'dok', label: 'dok', available: true, agents: [{ name: 'helper', description: 'Remote helper', repo: 'dev-workflow' }] },
    { id: 'mac', label: 'This Mac', available: true, agents: [{ name: 'helper', description: 'Local helper', workspace: '/tmp' }, { name: 'workflow', description: 'Local workflow', workspace: 'here' }] },
  ],
  start_requests: [],
  generated_at: '2026-10-09T05:00:00.000Z',
  status: { agents: 2, running: 1, pending: { memory: 1, proposals: 0 } },
  runs: [
    { run_id: 'r-1', agent: 'helper', status: 'completed', task: 'List the tools', started: '2026-10-09T04:50:00.000Z', ended: '2026-10-09T04:51:00.000Z' },
    { run_id: 'r-2', agent: 'network', status: 'running', task: 'Which app uses the most data?', started: '2026-10-09T04:59:00.000Z' },
  ],
  agents: [{ name: 'helper', description: 'Answers questions', workspace: '/repo', last_run: { run_id: 'r-1', status: 'completed' } }, { name: 'workflow', description: 'Develops', workspace: 'here' }],
  pending: [{ id: 'm-1', kind: 'memory', agent: 'claude-code', body: 'Prefer small real examples.' }],
}

for (const source of ['hub', 'local (Hub unreachable)']) {
  test(`Hub review items stay read-only, including cached fallback (${source})`, async ($, on) => {
    const calls: string[] = []
    const message = 'Decide this in the Agents Hub panel (the Hub keeps ratings and memory notes; the Mac cannot decide them).'
    on('process.run', async (_$, e) => {
      calls.push(e.argv[3] ?? '')
      const data = { ...DASHBOARD, source, decision_message: message,
        runs: [{ ...DASHBOARD.runs[0], task: undefined, title: 'A dok receipt', runner: 'dok' }],
        pending: [{ ...DASHBOARD.pending[0], hub: true }] }
      return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    on('clock.after', async () => ({ deny: 'no timers in this test' }) as never)
    on('ui.status', async () => ({ value: undefined }) as never)
    const ui = await $.ui.mount({ plugin: 'agents-panel', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PROPS as never })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: source === 'hub' ? 'Source: Agents Hub' : `Source: ${source}` })).toBeDefined()
    expect(await ui.find({ text: '1 running' })).toBeDefined() // use the Hub's count, even outside the recent window
    expect(await ui.find({ text: 'A dok receipt' })).toBeDefined()
    await ui.press({ key: 'tab-review' })
    expect(await ui.find({ text: message })).toBeDefined()
    expect(await ui.find({ key: 'accept-m-1' })).toBeUndefined()
    expect(await ui.find({ key: 'reject-m-1' })).toBeUndefined()
    expect(calls.includes('review_decide')).toBe(false)
  })
}

const PROPS = { title: 'Agents', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws runs and review items, opens a run and decides on a click (${surface})`, async ($, on) => {
    const calls: string[][] = []
    on('process.run', async (_$, e) => {
      const [, , , op, json] = e.argv
      calls.push([op ?? '', json ?? ''])
      const out = op === 'open_dashboard' ? DASHBOARD
        : op === 'list_agents' ? DASHBOARD.agents
        : op === 'get_run' ? { run_id: 'r-1', agent: 'helper', status: 'completed', task: 'List the tools', output: 'tools/space-backup/' }
        : op === 'review_decide' ? 'accepted m-1'
        : op === 'start_selected_run' ? { run_id: 'r-3', status: 'running' }
        : null
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    on('session.start', async () => ({ cwd: '/tmp' }) as never)
    on('command.register', async () => ({ value: undefined }) as never)
    on('ui.open', async () => ({ value: undefined }) as never)
    on('ui.status', async () => ({ value: undefined }) as never)
    on('clock.after', async () => ({ deny: 'no timers in this test' }) as never)

    await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
    const ui = await $.ui.mount({ plugin: 'agents-panel', surface, component: 'Pane', requestId: 'agents', props: PROPS as never })

    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: 'network' })).toBeDefined()
    expect(await ui.find({ text: '1 running' })).toBeDefined()

    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ text: 'Answers questions' })).toBeDefined()
    expect(await ui.find({ text: 'No recorded run.' })).toBeDefined()
    await ui.press({ key: 'last-helper' })
    expect(await ui.find({ text: 'tools/space-backup/' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'tab-runs' })

    // a run's output
    await ui.press({ key: 'run-r-1' })
    expect(await ui.find({ text: 'tools/space-backup/' })).toBeDefined()
    await ui.press({ key: 'back' })

    // review: accept, and reject with a reason
    await ui.press({ key: 'tab-review' })
    expect(await ui.find({ text: 'Prefer small real examples.' })).toBeDefined()
    await ui.press({ key: 'accept-m-1' })
    expect(calls).toContainEqual(['review_decide', JSON.stringify({ id: 'm-1', decision: 'accept' })])
    await ui.press({ key: 'reject-m-1' })
    await ui.input({ key: 'reason-m-1', text: 'not now' })
    expect(calls).toContainEqual(['review_decide', JSON.stringify({ id: 'm-1', decision: 'reject', reason: 'not now' })])

    // start a run of a "here" agent in the session's folder
    await ui.press({ key: 'tab-start' })
    expect(await ui.find({ text: 'Runs on dok' })).toBeDefined()
    await ui.select({ key: 'runner', value: 'mac' })
    expect(await ui.find({ text: 'Runs on this Mac' })).toBeDefined()
    await ui.select({ key: 'agent', value: 'workflow' })
    await ui.input({ key: 'task', text: 'Check the tests' })
    const start = calls.find(([op]) => op === 'start_selected_run')
    expect(start).toBeDefined()
    const args = JSON.parse(start![1])
    expect(args.runner).toBe('mac'); expect(args.agent).toBe('workflow'); expect(args.cwd).toBe('/tmp')
    expect(args.task).toBe('Check the tests'); expect(typeof args.request_id).toBe('string')
    expect(calls.some(([op]) => op === 'start_run')).toBe(false)
  })
}

test('dok is the default; offline stays selected and the Mac choice remains available', async ($, on) => {
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const op = e.argv[3]; calls.push(op ?? '')
    const data = { ...DASHBOARD, source: 'hub', run_targets: [
      { ...DASHBOARD.run_targets[0], available: false, reason: 'dok is offline.' }, DASHBOARD.run_targets[1]],
      start_requests: [{ request_id: 'request-lost', runner: 'dok', agent: 'helper', task: 'Old task', state: 'unknown' }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('clock.after', async () => ({ deny: 'no timers in this test' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  const ui = await $.ui.mount({ plugin: 'agents-panel', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PROPS as never })
  await ui.press({ key: 'refresh' }); await ui.press({ key: 'tab-start' })
  expect(await ui.find({ text: 'Runs on dok' })).toBeDefined()
  expect(await ui.find({ text: 'dok is offline.' })).toBeDefined()
  await ui.input({ key: 'task', text: 'Must not start' })
  expect(calls.includes('start_selected_run')).toBe(false)
  expect(await ui.find({ text: 'request-lost' })).toBeDefined()
  expect(await ui.find({ key: 'check-request-lost' })).toBeDefined()
  await ui.select({ key: 'runner', value: 'mac' })
  expect(await ui.find({ text: 'Runs on this Mac' })).toBeDefined()
  expect(await ui.find({ text: 'Local helper' })).toBeDefined()
})

test('a new panel blocks starts when local selection support is missing', async ($, on) => {
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    calls.push(e.argv[3] ?? '')
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...DASHBOARD, runner_selection: undefined }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('clock.after', async () => ({ deny: 'no timers in this test' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  const ui = await $.ui.mount({ plugin: 'agents-panel', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PROPS as never })
  await ui.press({ key: 'refresh' }); await ui.press({ key: 'tab-start' })
  await ui.input({ key: 'task', text: 'Blocked request' })
  expect(calls.includes('start_selected_run')).toBe(false)
  expect(calls.includes('start_run')).toBe(false)
  expect(await ui.find({ text: 'Update the local operations before selecting a runner.' })).toBeDefined()
})

test('default dok submits only explicit remote arguments', async ($, on) => {
  let submitted: Record<string, unknown> | undefined
  on('process.run', async (_$, e) => {
    const op = e.argv[3]
    if (op === 'start_selected_run') submitted = JSON.parse(e.argv[4] ?? '{}')
    const data = op === 'open_dashboard' ? DASHBOARD : op === 'start_selected_run'
      ? { run_id: 'r-dok', status: 'running' } : { run_id: 'r-dok', status: 'running', agent: 'helper', runner: 'dok', task: 'Read only' }
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('clock.after', async () => ({ deny: 'no timers in this test' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  const ui = await $.ui.mount({ plugin: 'agents-panel', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PROPS as never })
  await ui.press({ key: 'refresh' }); await ui.press({ key: 'tab-start' })
  await ui.input({ key: 'task', text: 'Read only' })
  expect(submitted?.runner).toBe('dok'); expect(submitted?.agent).toBe('helper')
  expect(submitted?.cwd).toBeUndefined(); expect(submitted?.continue).toBeUndefined()
  expect(submitted?.model).toBeUndefined(); expect(submitted?.repo).toBeUndefined()
})
