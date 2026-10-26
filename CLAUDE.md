# mcp.backx.trade

The BackX MCP server only. The owner is not a developer: explain briefly, in Norwegian.

## Two repositories, kept apart (owner 2026-10-26)
- **This repo (`voicebillz/mcp.backx.trade`)**: the MCP server at mcp.backx.trade. Its own Railway project
  ("backx-mcp") with its own Redis. Code here: OAuth 2.1, MCP tools, prepared-transaction bundles. Push to `main` here.
- **`voicebillz/backx.trade`**: everything else: contracts, api.backx.trade, the web app and front page, docs. The
  MCP pieces that live THERE: the API's `/api/mcp/*` (consent, verify, disconnect), `/mcp/grant-key`, the signed
  `/internal/mcp/*` route (server/src/mcp.js), and the app pages `/connect` and `/sign` (web/src/pages/McpPages.tsx).
  The plan is `docs/backx/MCP-PLAN.md` there.
- Never copy code between them; the only contract between the two is: the API's grant (EdDSA JWT, 2 min, iss
  `https://api.backx.trade`, aud `https://mcp.backx.trade`, claims `sub`, `wallet`, `req`, `scope`, `jti`) and the
  signed internal call (`x-mcp-sig` = ed25519 over the raw JSON `{ op, sub, ts, nonce }`). Change both repos together
  when that changes, and say so in both commits.

## Security (locked)
- Only social-login accounts may connect; the API decides (Privy linked accounts, never the client).
- This server never signs a transaction and never holds a private key. Prepared steps are signed by the user on
  app.backx.trade/sign after the API's independent check (only BackX contracts, own wallet).
- No access to the main database, main Redis, Privy secret or ADMIN_WALLETS. Its own ed25519 key lives only in its
  own Redis; only the public half is shown (`/.well-known/backx-mcp-key`).
- Tokens: opaque, SHA-256 hashed in Redis, access 15 min, refresh 30 days rotated; every refresh re-checks the
  account with the API. PKCE S256, exact redirect URIs (https, or http on loopback), one-use codes and grants.
- Rate limits in Redis on every endpoint; Redis down = 503, never let it through. No stack traces in responses.
- The wallet always comes from the token, never from tool input. Addresses only from agents.json / factory.setOf.
- Amounts that are sent are rounded DOWN (`toUnits`). Copy: "Leverage", "Long"; no yield promises.
- Pinned dependency versions; Node 24.22.1 in Docker, bump on every Node.js security release.
