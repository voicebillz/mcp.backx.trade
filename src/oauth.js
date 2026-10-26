import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { config } from './config.js';
import { account } from './api.js';

// OAuth 2.1 for MCP (authorization server + protected resource, MCP authorization spec). PKCE S256 only, public
// clients, exact redirect URIs, short-lived opaque tokens. Who the user is comes ONLY from a consent grant signed by
// api.backx.trade after a normal BackX login on app.backx.trade/connect, where the API also checks that the account
// logs in with a social method (owner 2026-10-26: external-wallet accounts cannot connect). Tokens are stored as
// SHA-256 hashes, never in clear.

export const SCOPES = ['account:read', 'trade:prepare', 'issue:prepare', 'stake:prepare', 'claim:prepare'];
const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 86400;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');
const resource = () => `${config.publicUrl}/mcp`;

let grantKey = null;
async function grantPublicKey() {
  if (!grantKey) {
    const b64 = config.apiGrantPublicKey.replace(/\s+/g, '');
    grantKey = await importSPKI(`-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`, 'EdDSA');
  }
  return grantKey;
}

/** Fixed-window rate limit in Redis. Throws when Redis is down (callers answer 503: never let it through). */
export async function limited(redis, key, max, windowSec = 60) {
  const k = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const [[, n]] = await redis.multi().incr(k).expire(k, windowSec + 10).exec();
  return n > max;
}

/** A redirect URI a client may register: https anywhere, http only on the loopback (desktop apps). No fragments. */
function okRedirect(u) {
  if (typeof u !== 'string' || u.length > 512) return false;
  let p;
  try { p = new URL(u); } catch { return false; }
  if (p.hash || p.username || p.password) return false;
  if (p.protocol === 'https:') return true;
  return p.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(p.hostname);
}
const cleanName = (s) => String(s ?? '').replace(/[^\p{L}\p{N} ._()\-]/gu, '').trim().slice(0, 80) || 'Unnamed app';
const scopeList = (s) => [...new Set(String(s || '').split(/\s+/).filter(Boolean))];

function redirectWith(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

export const oauthRouter = express.Router();

// Discovery documents.
const protectedResource = (_req, res) => res.json({
  resource: resource(), authorization_servers: [config.publicUrl], scopes_supported: SCOPES, bearer_methods_supported: ['header'],
  resource_name: 'BackX', resource_documentation: 'https://www.backx.trade/skill.md',
});
oauthRouter.get('/.well-known/oauth-protected-resource', protectedResource);
oauthRouter.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
oauthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
  issuer: config.publicUrl,
  authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
  token_endpoint: `${config.publicUrl}/oauth/token`,
  registration_endpoint: `${config.publicUrl}/oauth/register`,
  revocation_endpoint: `${config.publicUrl}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: SCOPES,
}));

// Rate limit every OAuth endpoint per IP; Redis down = 503.
oauthRouter.use('/oauth', async (req, res, next) => {
  try {
    if (await limited(req.app.locals.redis, `oauth:${req.ip}`, config.rateLimitPerMin)) return res.status(429).json({ error: 'rate_limited' });
    next();
  } catch { res.status(503).json({ error: 'temporarily_unavailable' }); }
});

// Dynamic client registration (RFC 7591), public clients only. A client gets nothing by registering: the user
// still has to log in and approve it on app.backx.trade, which shows its name and where it sends the user back.
oauthRouter.post('/oauth/register', express.json({ limit: '8kb' }), async (req, res) => {
  const redis = req.app.locals.redis;
  try {
    if (await limited(redis, `register:${req.ip}`, 20, 3600)) return res.status(429).json({ error: 'rate_limited' });
  } catch { return res.status(503).json({ error: 'temporarily_unavailable' }); }
  const uris = req.body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(okRedirect)) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }
  const client = {
    client_id: `mcp_${rand(18)}`, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: cleanName(req.body.client_name),
    redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  };
  await redis.set(`mcp:client:${client.client_id}`, JSON.stringify(client), 'EX', 180 * 86400);
  res.status(201).json(client);
});

const getClient = async (redis, id) => (typeof id === 'string' && /^mcp_[A-Za-z0-9_-]{24}$/.test(id) ? JSON.parse((await redis.get(`mcp:client:${id}`)) || 'null') : null);

// Step 1: the client sends the user here. Checked strictly, then the user goes to the BackX consent page.
oauthRouter.get('/oauth/authorize', async (req, res) => {
  const redis = req.app.locals.redis;
  const q = req.query;
  const client = await getClient(redis, q.client_id);
  // Without a known client and an exact registered redirect URI we never redirect anywhere.
  if (!client || typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri)) {
    return res.status(400).type('text').send('Unknown client or redirect URI.');
  }
  const state = typeof q.state === 'string' ? q.state.slice(0, 512) : undefined;
  const fail = (error) => redirectWith(res, q.redirect_uri, { error, state });
  if (q.response_type !== 'code') return fail('unsupported_response_type');
  if (q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return fail('invalid_request');
  if (q.resource != null && String(q.resource).replace(/\/+$/, '') !== resource()) return fail('invalid_target');
  const asked = scopeList(q.scope);
  const scopes = asked.length ? asked : ['account:read'];
  if (!scopes.every((s) => SCOPES.includes(s))) return fail('invalid_scope');
  const id = rand(24);
  await redis.set(`mcp:req:${id}`, JSON.stringify({
    client_id: client.client_id, client_name: client.client_name, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state, scopes,
  }), 'EX', 600);
  const to = new URL(config.connectUrl);
  to.searchParams.set('request', id);
  res.redirect(302, to.toString());
});

// The consent page reads what it is approving from here (not from its own URL, so a link cannot fake it).
oauthRouter.get('/oauth/request/:id', async (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': config.appOrigin, Vary: 'Origin' });
  if (!/^[A-Za-z0-9_-]{32}$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = JSON.parse((await req.app.locals.redis.get(`mcp:req:${req.params.id}`)) || 'null');
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json({ client: r.client_name, redirectHost: new URL(r.redirect_uri).host, scopes: r.scopes });
});

// Step 2: the consent page sends the browser here with the API's signed grant (or a refusal).
oauthRouter.get('/oauth/callback', async (req, res) => {
  const redis = req.app.locals.redis;
  const id = String(req.query.request || '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) return res.status(400).type('text').send('Bad request.');
  const r = JSON.parse((await redis.getdel(`mcp:req:${id}`)) || 'null'); // one use
  if (!r) return res.status(400).type('text').send('This link has expired. Start the connection again from your assistant.');
  if (req.query.denied === '1') return redirectWith(res, r.redirect_uri, { error: 'access_denied', state: r.state });
  let g;
  try {
    ({ payload: g } = await jwtVerify(String(req.query.grant || ''), await grantPublicKey(), {
      issuer: config.apiUrl, audience: config.publicUrl, algorithms: ['EdDSA'], maxTokenAge: '2m',
    }));
  } catch { return redirectWith(res, r.redirect_uri, { error: 'access_denied', state: r.state }); }
  if (g.req !== id || typeof g.sub !== 'string' || !/^0x[0-9a-f]{40}$/.test(g.wallet || '') || typeof g.jti !== 'string') {
    return redirectWith(res, r.redirect_uri, { error: 'access_denied', state: r.state });
  }
  if ((await redis.set(`mcp:jti:${g.jti}`, '1', 'EX', 300, 'NX')) !== 'OK') return redirectWith(res, r.redirect_uri, { error: 'access_denied', state: r.state });
  const granted = Array.isArray(g.scope) ? g.scope : [];
  const scopes = r.scopes.filter((s) => granted.includes(s));
  if (!scopes.length) return redirectWith(res, r.redirect_uri, { error: 'access_denied', state: r.state });
  const code = rand();
  await redis.set(`mcp:code:${sha(code)}`, JSON.stringify({
    client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, sub: g.sub, wallet: g.wallet, scopes,
  }), 'EX', 60);
  redirectWith(res, r.redirect_uri, { code, state: r.state });
});

async function issue(redis, t) {
  const access = rand(), refresh = rand();
  const at = { sub: t.sub, wallet: t.wallet, scopes: t.scopes, client_id: t.client_id, exp: Date.now() + ACCESS_TTL * 1000 };
  await redis.multi()
    .set(`mcp:at:${sha(access)}`, JSON.stringify(at), 'EX', ACCESS_TTL)
    .set(`mcp:rt:${sha(refresh)}`, JSON.stringify({ sub: t.sub, wallet: t.wallet, scopes: t.scopes, client_id: t.client_id }), 'EX', REFRESH_TTL)
    .sadd(`mcp:user:${t.sub}`, sha(refresh)).expire(`mcp:user:${t.sub}`, REFRESH_TTL)
    .exec();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: t.scopes.join(' ') };
}

// Step 3: code → tokens (PKCE), and refresh with rotation. Each refresh asks the API again whether the account may
// still connect, so a user who switched to an external-wallet login or was removed loses access within 15 minutes.
oauthRouter.post('/oauth/token', express.urlencoded({ extended: false, limit: '8kb' }), express.json({ limit: '8kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const redis = req.app.locals.redis;
  const b = req.body || {};
  const bad = (error, status = 400) => res.status(status).json({ error });
  if (b.grant_type === 'authorization_code') {
    if (typeof b.code !== 'string' || typeof b.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier)) return bad('invalid_request');
    const c = JSON.parse((await redis.getdel(`mcp:code:${sha(b.code)}`)) || 'null');
    if (!c || c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return bad('invalid_grant');
    const challenge = createHash('sha256').update(b.code_verifier).digest('base64url');
    if (challenge !== c.code_challenge) return bad('invalid_grant');
    return res.json(await issue(redis, c));
  }
  if (b.grant_type === 'refresh_token') {
    if (typeof b.refresh_token !== 'string') return bad('invalid_request');
    const h = sha(b.refresh_token);
    const t = JSON.parse((await redis.getdel(`mcp:rt:${h}`)) || 'null'); // rotation: each refresh token works once
    if (!t || t.client_id !== b.client_id) return bad('invalid_grant');
    await redis.srem(`mcp:user:${t.sub}`, h);
    let acct;
    try { acct = await account(t.sub); } catch { return bad('temporarily_unavailable', 503); }
    if (!acct?.eligible || !/^0x[0-9a-f]{40}$/.test(acct.wallet || '')) return bad('invalid_grant');
    return res.json(await issue(redis, { ...t, wallet: acct.wallet }));
  }
  return bad('unsupported_grant_type');
});

oauthRouter.post('/oauth/revoke', express.urlencoded({ extended: false, limit: '8kb' }), express.json({ limit: '8kb' }), async (req, res) => {
  const redis = req.app.locals.redis;
  const tok = String(req.body?.token || '');
  if (tok) {
    const h = sha(tok);
    const rt = JSON.parse((await redis.getdel(`mcp:rt:${h}`)) || 'null');
    if (rt) await redis.srem(`mcp:user:${rt.sub}`, h);
    await redis.del(`mcp:at:${h}`);
  }
  res.status(200).end(); // RFC 7009: always 200
});

/** Bearer token check for /mcp. Sets req.auth = { sub, wallet, scopes, client_id }. */
export async function requireToken(req, res, next) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || '');
  const challenge = `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`;
  if (!m) return res.status(401).set('WWW-Authenticate', challenge).json({ error: 'unauthorized' });
  let t;
  try { t = JSON.parse((await req.app.locals.redis.get(`mcp:at:${sha(m[1])}`)) || 'null'); } catch { return res.status(503).json({ error: 'unavailable' }); }
  if (!t || t.exp < Date.now()) return res.status(401).set('WWW-Authenticate', `${challenge}, error="invalid_token"`).json({ error: 'invalid_token' });
  req.auth = t;
  next();
}

/** Ends every connection of a user (called when the API says the account disconnected MCP). */
export async function revokeUser(redis, sub) {
  const hashes = await redis.smembers(`mcp:user:${sub}`);
  const pipe = redis.multi().del(`mcp:user:${sub}`);
  for (const h of hashes) pipe.del(`mcp:rt:${h}`);
  await pipe.exec();
}
