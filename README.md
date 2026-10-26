# mcp.backx.trade

The BackX MCP server: a user connects their own AI assistant (Claude, ChatGPT, Cursor …) to **their own BackX
account**. Plan and rules: `docs/backx/MCP-PLAN.md` in the main repository (`voicebillz/backx.trade`).

- **Who can connect**: only accounts that log in to BackX with a social method (email, phone, Google, X, Discord,
  Twitch, Telegram, Farcaster, passkey). Accounts that log in with their own wallet use `backx.trade/skill.md` instead.
- **What it can do**: read the user's balances, positions, rewards and staking from the chain, and *prepare*
  transactions (trade, issue, withdraw, stake, unstake, Claim all). The user signs them on
  `app.backx.trade/sign`, where api.backx.trade first checks every step only touches BackX contracts and pays back
  to the user's own wallet. This server never signs, never holds a private key.
- **What it cannot reach**: the main database, the main Redis, Privy's app secret. It runs in its own Railway
  project with its own Redis.

## How it fits together

```
assistant ──OAuth 2.1 + MCP──▶ mcp.backx.trade (this repo, own Railway project, own Redis)
                                  │ signed, read-only: POST /internal/mcp/account
                                  ▼
                           api.backx.trade (backx.trade repo)
app.backx.trade/connect  ─ the user logs in and approves → the API signs a 2-minute grant → this server
app.backx.trade/sign     ─ the user signs prepared steps after the API's own check
```

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP (Streamable HTTP, stateless). Bearer token required. |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | OAuth discovery |
| `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | OAuth 2.1, PKCE S256, public clients |
| `/oauth/request/:id`, `/oauth/callback` | used by the consent page on app.backx.trade |
| `/bundle/:id` | prepared transactions for the sign page (15 min) |
| `/.well-known/backx-mcp-key` | this server's public key (pinned in the API as `MCP_PUBLIC_KEY`) |
| `/health` | `{ ok }` only |

Tools: `backx_status`, `markets_list`, `account_get`, `rewards_get`, `positions_list`, `prepare_open`,
`prepare_close`, `prepare_issue`, `prepare_withdraw`, `prepare_stake`, `prepare_unstake`, `prepare_claim_all`.

## Environment

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PUBLIC_URL` | yes | `https://mcp.backx.trade` |
| `REDIS_URL` | yes | this project's own Redis (`${{Redis.REDIS_URL}}`) |
| `API_GRANT_PUBLIC_KEY` | yes | the `spki` value from `https://api.backx.trade/mcp/grant-key` |
| `API_URL` | no | default `https://api.backx.trade` |
| `CONNECT_URL`, `SIGN_URL`, `AGENTS_URL` | no | defaults `https://app.backx.trade/connect`, `/sign`, `https://www.backx.trade/agents.json` |

Never give this service `DATABASE_URL`, the main `REDIS_URL`, `PRIVY_APP_SECRET`, `ADMIN_WALLETS` or any private key.
Its own signing key is made on first start and kept in its own Redis.

## Oppskrift: sette det opp i Railway (for eieren)

Gjør stegene i denne rekkefølgen. Ingen hemmeligheter skal kopieres noe sted, bare offentlige nøkler.

**1. API-et først (det eksisterende backx-prosjektet)**
1. Endringene i `backx.trade` (API + app) er pushet til `main`. Vent til API-et har deployet.
2. Åpne `https://api.backx.trade/mcp/grant-key` i nettleseren. Kopier verdien etter `"spki"` (lang tekst som
   begynner med `MCow`). Det er en **offentlig** nøkkel, trygg å kopiere.

**2. Nytt prosjekt for MCP**
1. Railway → **New Project** → **Deploy from GitHub repo** → velg `voicebillz/mcp.backx.trade`. Kall prosjektet
   `backx-mcp`.
2. I samme prosjekt: **+ New** → **Database** → **Redis**. Ikke slå på offentlig nettverk for Redis.
3. Klikk på MCP-tjenesten → **Variables**, legg inn:
   - `NODE_ENV` = `production`
   - `PUBLIC_URL` = `https://mcp.backx.trade`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}` (velg fra listen)
   - `API_GRANT_PUBLIC_KEY` = verdien du kopierte i steg 1.2
4. **Settings** → **Networking** → **Custom Domain** → `mcp.backx.trade`. Legg inn CNAME-oppføringen Railway viser
   hos domeneleverandøren din. Vent til den er grønn.
5. Sjekk `https://mcp.backx.trade/health` → skal vise `{"ok":true}`.

**3. Koble dem sammen**
1. Åpne `https://mcp.backx.trade/.well-known/backx-mcp-key` og kopier verdien etter `"spki"` (også offentlig).
2. I det **gamle** backx-prosjektet: API-tjenesten → **Variables** → `MCP_PUBLIC_KEY` = den verdien. Railway
   deployer API-et på nytt.

**4. Test**
1. I Claude: **Settings → Connectors → Add custom connector** → URL `https://mcp.backx.trade/mcp`.
2. Du sendes til `app.backx.trade/connect`, logger inn med e-post/Google osv., og godkjenner.
3. Spør Claude: "Hva er BackX-statusen min?" Før lansering svarer den at kontraktene ikke er live ennå.

Hvis Redis i MCP-prosjektet noen gang slettes, lages en ny nøkkel: gjenta steg 3.

## Development

```
npm ci
npm test
PUBLIC_URL=http://127.0.0.1:8092 REDIS_URL=redis://127.0.0.1:6379 API_GRANT_PUBLIC_KEY=<spki> node src/index.js
```
Pinned dependencies, Node 24.22.1 in Docker (bump with every Node.js security release, same as the API).
