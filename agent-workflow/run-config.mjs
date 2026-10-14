// Bounded, presentation-safe configuration observations for a run receipt.
// This records metadata only: never raw initialize params, tool schemas, prompts or credentials.
const key = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : null;
const text = value => typeof value === 'string' && value.length <= 80 && !/[\x00-\x1f\x7f]|Bearer\s|\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/i.test(value) ? value : undefined;

function capabilityValue(value, depth = 0) {
  if (typeof value === 'boolean') return value;
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [name, child] of Object.entries(value).slice(0, 32)) {
    const safe = key(name);
    if (!safe) continue;
    const normalized = capabilityValue(child, depth + 1);
    if (normalized !== undefined) out[safe] = normalized;
  }
  return Object.keys(out).length ? out : {};
}

export function advertisedCapabilities(value) {
  const normalized = capabilityValue(value);
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized) ? normalized : {};
}

export function mcpConnection(value) {
  if (!value || typeof value !== 'object') return undefined;
  const protocol = text(value.protocol_version ?? value.protocolVersion);
  const capabilities = advertisedCapabilities(value.capabilities);
  const source = text(value.source);
  const client = value.client && typeof value.client === 'object' ? {
    ...(text(value.client.name) ? { name: text(value.client.name) } : {}),
    ...(text(value.client.version) ? { version: text(value.client.version) } : {}),
  } : {};
  return {
    status: protocol ? 'negotiated' : 'observed',
    protocol_version: protocol ?? null,
    capabilities,
    ...(Object.keys(client).length ? { client } : {}),
    ...(source ? { source } : {}),
  };
}

export function mcpDisabled(source) {
  return { status: 'disabled', protocol_version: null, capabilities: {}, source: source ?? 'runner' };
}

export function runtimeConfig(runtime) {
  if (!runtime || typeof runtime !== 'object') return undefined;
  const out = Object.fromEntries(['engine', 'provider', 'model', 'thinking', 'pi_version', 'observed_at']
    .map(k => [k, text(runtime[k])]).filter(([, v]) => v !== undefined));
  if (runtime.mcp && typeof runtime.mcp === 'object') {
    const mcp = runtime.mcp;
    out.mcp = {
      status: ['disabled', 'negotiated', 'observed', 'unavailable'].includes(mcp.status) ? mcp.status : 'unavailable',
      protocol_version: text(mcp.protocol_version) ?? null,
      capabilities: advertisedCapabilities(mcp.capabilities),
      ...(text(mcp.source) ? { source: text(mcp.source) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function runConfiguration({ runtime, mcp_connection } = {}) {
  const config = {};
  const observed = runtimeConfig(runtime);
  if (observed) config.runtime = observed;
  const connection = mcpConnection(mcp_connection);
  if (connection) config.mcp_connection = connection;
  return Object.keys(config).length ? config : undefined;
}
