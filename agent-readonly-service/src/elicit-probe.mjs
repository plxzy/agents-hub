// TEMPORARY (2026-10-12): probe whether hosted clients show a native MCP elicitation prompt for this connector.
// On only while env.ELICIT_PROBE is "true". It records protocol facts (client name/version, protocol version,
// capabilities, Accept, which shape was used, the answer) in its own D1 table, never the owner identity.
// Shapes: MRTR (protocol 2026-07-28+, stateless input_required + retry) and classic (server request on an SSE stream,
// answer POSTed back, picked up here by polling D1 because the answer may reach another isolate).

export const PROBE_TOOL = {
  name: 'elicitation_probe', title: 'Elicitation test',
  description: 'TEST ONLY. Asks the user, in a native prompt, to keep or reject a sample memory note, then returns what the user chose. '
    + 'Call it only when the user asks for the elicitation test, and report the returned text exactly.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', enum: ['auto', 'elicitation/create', 'openai/elicitation/create', 'openai/form'],
      description: 'Classic-shape method name; auto picks openai/form for the Codex app. Leave unset unless the user names one.' } } },
  annotations: { title: 'Elicitation test', readOnlyHint: true },
};

const MESSAGE = 'Test: the helper agent proposed this memory note:\n\n"Prefer small real examples over long abstract explanations."\n\nKeep it or reject it?';
const SCHEMA = { type: 'object', required: ['decision'], properties: {
  decision: { type: 'string', title: 'Decision', oneOf: [{ const: 'keep', title: 'Keep it' }, { const: 'reject', title: 'Reject it' }] },
  reason: { type: 'string', title: 'Reason (optional)', description: 'Why, in your words' } } };
const WAIT_MS = 300000, POLL_MS = 1000, PING_MS = 15000;

const enabled = (env) => env.ELICIT_PROBE === 'true';
export const probeTools = (env) => (enabled(env) ? [PROBE_TOOL] : []);

async function table(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS elicit_probe (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)').run();
}
async function record(env, kind, data, id = crypto.randomUUID()) {
  try {
    await table(env);
    await env.DB.prepare('INSERT OR REPLACE INTO elicit_probe (id, at, kind, data) VALUES (?, ?, ?, ?)')
      .bind(id, new Date().toISOString(), kind, JSON.stringify(data)).run();
  } catch { /* the probe never breaks the Hub */ }
}

const facts = (request, params = {}) => ({
  accept: request.headers.get('accept'), protocol_header: request.headers.get('mcp-protocol-version'),
  session_header: request.headers.has('mcp-session-id'), user_agent: (request.headers.get('user-agent') ?? '').slice(0, 120),
  meta_version: params?._meta?.['io.modelcontextprotocol/protocolVersion'] ?? null,
  meta_client: params?._meta?.['io.modelcontextprotocol/clientInfo'] ?? null,
  meta_caps: params?._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? null,
});

/** Called for every initialize: the client's declared protocol version and capabilities. */
export async function probeInitialize(request, env, params) {
  if (!enabled(env)) return;
  await record(env, 'initialize', { client: params?.clientInfo ?? null, version: params?.protocolVersion ?? null,
    capabilities: params?.capabilities ?? null, ...facts(request) });
}

/** A JSON-RPC response from the client to one of the probe's classic requests. Returns a Response when it was ours. */
export async function probeClientResponse(env, msg) {
  if (!enabled(env) || typeof msg?.id !== 'string' || !msg.id.startsWith('probe-') || msg.method) return null;
  await record(env, 'answer', { result: msg.result ?? null, error: msg.error ?? null }, msg.id);
  return new Response(null, { status: 202 });
}

// The Codex app (user agent `openai-mcp/… (Codex)`) declared extensions["openai/form"] on 2026-10-12; OpenAI's Bits & Bolts
// example answers that capability with method `openai/form` and params { message, requestedSchema } (no `mode`).
const isCodexApp = (request) => /\(Codex\)/.test(request.headers.get('user-agent') ?? '');
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const text = (t) => ({ content: [{ type: 'text', text: t }] });

/** tools/call elicitation_probe. Returns the JSON-RPC message to send, or a streaming Response (classic shape). */
export async function probeCall(request, env, id, params) {
  const f = facts(request, params), args = params?.arguments ?? {};
  const version = f.meta_version ?? f.protocol_header ?? '';
  // MRTR retry: the client answered the input request and repeated the call.
  if (params?.inputResponses) {
    const answer = params.inputResponses.decision ?? params.inputResponses;
    await record(env, 'mrtr-answer', { answer, request_state: params.requestState ?? null, ...f });
    return rpcResult(id, text(`USER_ANSWER (MRTR) ${JSON.stringify(answer)}`));
  }
  if (version >= '2026-07-28') {
    const openai = Boolean(f.meta_caps?.extensions?.['openai/elicitation']);
    await record(env, 'mrtr-ask', { openai, ...f });
    return rpcResult(id, { resultType: 'input_required', requestState: crypto.randomUUID(), inputRequests: { decision: {
      method: 'elicitation/create',
      params: openai
        ? { mode: 'form', message: MESSAGE, requestedSchema: { type: 'object', properties: {} }, _meta: { 'openai/elicitation': { requestedSchema: SCHEMA } } }
        : { mode: 'form', message: MESSAGE, requestedSchema: SCHEMA } } } });
  }
  if (!(request.headers.get('accept') ?? '').includes('text/event-stream')) {
    await record(env, 'classic-no-sse', f);
    return rpcResult(id, text('PROBE_RESULT client does not accept an SSE stream, so a classic elicitation request cannot be sent.'));
  }
  const method = args.method && args.method !== 'auto' ? args.method : isCodexApp(request) ? 'openai/form' : 'elicitation/create';
  const askId = `probe-${crypto.randomUUID()}`;
  await record(env, 'classic-ask', { method, ask_id: askId, schema: env.ELICIT_SCHEMA ?? 'choice', ...f });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter(), enc = new TextEncoder();
  const send = (msg) => writer.write(enc.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
  (async () => {
    try {
      // ELICIT_SCHEMA=minimal sends Bits & Bolts' simplest form (cad.reference: message + empty object schema).
      const schema = env.ELICIT_SCHEMA === 'minimal' ? { type: 'object', properties: {} } : SCHEMA;
      await send({ jsonrpc: '2.0', id: askId, method, params: method === 'openai/form' ? { message: MESSAGE, requestedSchema: schema } : { mode: 'form', message: MESSAGE, requestedSchema: schema } });
      let answer = null, lastPing = Date.now();
      for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const row = await env.DB.prepare('SELECT data FROM elicit_probe WHERE id = ?').bind(askId).first();
        if (row) { answer = JSON.parse(row.data); break; }
        if (Date.now() - lastPing > PING_MS) { await writer.write(enc.encode(': ping\n\n')); lastPing = Date.now(); }
      }
      await send(rpcResult(id, text(answer ? `USER_ANSWER (classic ${method}) ${JSON.stringify(answer.result ?? answer.error)}` : 'PROBE_RESULT no answer within 5 minutes')));
    } catch (e) { await record(env, 'classic-error', { message: String(e?.message ?? e) }); }
    finally { try { await writer.close(); } catch { /* client went away */ } }
  })();
  return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
