// All configuration comes from the environment. Missing required values stop the server (no fallbacks for secrets).
// This service is deliberately separate from api.backx.trade (own Railway project, owner 2026-10-26): it has no
// database, no Privy app secret and no admin list. It never holds a private key.

function required(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function url(name, fallback) {
  const v = process.env[name]?.trim() || fallback;
  if (!v) throw new Error(`Missing required env ${name}`);
  const u = new URL(v); // throws on garbage
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:') throw new Error(`${name} must be https in production`);
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT) || 8080,
  // This server's own public address, e.g. https://mcp.backx.trade. Used as the OAuth issuer and MCP resource.
  publicUrl: url('PUBLIC_URL'),
  // Its own Redis (OAuth state, tokens, rate limits). Never the main API's Redis.
  redisUrl: required('REDIS_URL'),
  // The main API (api.backx.trade): only its signed /internal/mcp routes and its public grant key are used.
  apiUrl: url('API_URL', 'https://api.backx.trade'),
  // The main API's public key (base64 SPKI, ed25519) that signs consent grants. Shown at <API_URL>/mcp/grant-key.
  apiGrantPublicKey: required('API_GRANT_PUBLIC_KEY'),
  // The consent page on the app, and the page where users sign prepared transactions.
  connectUrl: url('CONNECT_URL', 'https://app.backx.trade/connect'),
  signUrl: url('SIGN_URL', 'https://app.backx.trade/sign'),
  appOrigin: new URL(url('CONNECT_URL', 'https://app.backx.trade/connect')).origin,
  // Public address book (written by backx.trade's agent-manifest workflow).
  agentsUrl: url('AGENTS_URL', 'https://www.backx.trade/agents.json'),
  // Requests per minute per IP on OAuth endpoints and per user on /mcp.
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) || 120,
};
