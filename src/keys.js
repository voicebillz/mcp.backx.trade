import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';

// This server's own ed25519 key: it signs the requests it makes to api.backx.trade's /internal/mcp routes.
// The key is made on first start and kept in this server's own Redis, so the private half never leaves this
// service, never sits in an env variable and is never shown to anyone. Its public half is published at
// /.well-known/backx-mcp-key; the owner pastes that into the main API's MCP_PUBLIC_KEY (Railway).
// If Redis is wiped a new key is made: paste the new public key into the API again.

const KEY = 'mcp:signing-key:v1';
let priv = null;
let pubB64 = null;

export async function loadSigningKey(redis) {
  let pem = await redis.get(KEY);
  if (!pem) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const fresh = privateKey.export({ format: 'pem', type: 'pkcs8' });
    // NX: if two instances start at once, both end up with the same key.
    await redis.set(KEY, fresh, 'NX');
    pem = await redis.get(KEY);
  }
  priv = createPrivateKey(pem);
  pubB64 = createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
  return pubB64;
}

export const publicKey = () => pubB64;

/** ed25519 signature (base64) over the exact request body bytes. */
export function signBody(buf) {
  if (!priv) throw new Error('signing key not loaded');
  return sign(null, buf, priv).toString('base64');
}
