import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { signBody } from './keys.js';

// The only link to the main API (api.backx.trade): signed, read-only calls to /internal/mcp. The API checks the
// signature against MCP_PUBLIC_KEY, the timestamp (±60 s) and the nonce (once), and answers only about the user
// named in the request. The user id itself comes from a token this server issued after the API's own consent grant.

export async function internal(op, body) {
  const payload = Buffer.from(JSON.stringify({ op, ...body, ts: Date.now(), nonce: randomBytes(16).toString('hex') }));
  const r = await fetch(`${config.apiUrl}/internal/mcp/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mcp-sig': signBody(payload) },
    body: payload,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`api ${op} ${r.status}`);
  return r.json();
}

/**
 * Has BackX paused MCP (admin switch on api.backx.trade)? Asked at most every 15 s. If the API cannot be reached the
 * last answer (kept 1 h) is used, and with no answer at all we treat it as paused: fail closed.
 */
export async function paused(redis) {
  const hit = await redis.get('mcp:paused');
  if (hit != null) return hit === '1';
  try {
    const { paused: p } = await internal('status', {});
    await redis.multi().set('mcp:paused', p ? '1' : '0', 'EX', 15).set('mcp:paused:last', p ? '1' : '0', 'EX', 3600).exec();
    return !!p;
  } catch {
    const last = await redis.get('mcp:paused:last');
    return last == null ? true : last === '1';
  }
}

/** Is this account still allowed (social login, embedded wallet) and what is its wallet? */
export const account = (sub) => internal('account', { sub });
