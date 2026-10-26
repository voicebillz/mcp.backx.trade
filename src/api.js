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

/** Is this account still allowed (social login, embedded wallet) and what is its wallet? */
export const account = (sub) => internal('account', { sub });
