import express from 'express';
import Redis from 'ioredis';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { oauthRouter, requireToken, limited } from './oauth.js';
import { loadSigningKey, publicKey } from './keys.js';
import { buildServer } from './tools.js';

// mcp.backx.trade (owner 2026-10-26, docs/backx/MCP-PLAN.md in backx.trade): a user's own AI assistant on their own
// BackX account. Separate Railway project: no database, no Privy secret, no private keys. It reads the chain and
// prepares transactions; the user signs them on app.backx.trade.

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: true });
redis.on('error', (e) => console.error('redis:', e.message));

const app = express();
app.locals.redis = redis;
app.disable('x-powered-by');
app.set('trust proxy', 1); // exactly one proxy hop (Railway's edge)

app.use((_req, res, next) => {
  res.set({
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
  next();
});

app.get('/health', async (_req, res) => {
  try { await redis.ping(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

// Public half of this server's signing key: the owner copies it into api.backx.trade's MCP_PUBLIC_KEY.
app.get('/.well-known/backx-mcp-key', (_req, res) => res.json({ alg: 'ed25519', spki: publicKey() }));

app.use(oauthRouter);

// Prepared transactions for the sign page on app.backx.trade (which checks the logged-in wallet matches).
app.get('/bundle/:id', async (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': config.appOrigin, Vary: 'Origin' });
  if (!/^[A-Za-z0-9_-]{24}$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  try {
    if (await limited(redis, `bundle:${req.ip}`, 60)) return res.status(429).json({ error: 'rate_limited' });
    const b = await redis.get(`mcp:bundle:${req.params.id}`);
    if (!b) return res.status(404).json({ error: 'expired' });
    res.type('json').send(b);
  } catch { res.status(503).json({ error: 'unavailable' }); }
});

// MCP over Streamable HTTP, stateless: every request carries its bearer token and gets a fresh server bound to
// that user, so one user's tools can never see another's wallet.
app.post('/mcp', requireToken, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    if (await limited(redis, `mcp:${req.auth.sub}`, config.rateLimitPerMin)) return res.status(429).json({ error: 'rate_limited' });
  } catch { return res.status(503).json({ error: 'unavailable' }); }
  const server = buildServer(req.auth, redis);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }));

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
// Never leak stack traces.
app.use((_err, _req, res, _next) => res.status(400).json({ error: 'bad_request' }));

await redis.connect(); // no Redis at boot = no start (fail closed)
const pub = await loadSigningKey(redis);
// The PUBLIC half only (safe to show): paste it into the main API's MCP_PUBLIC_KEY in Railway.
console.log(`MCP public key (api.backx.trade → MCP_PUBLIC_KEY): ${pub}`);
app.listen(config.port, () => console.log(`mcp.backx.trade on :${config.port}`));
