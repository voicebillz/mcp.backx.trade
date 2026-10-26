import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { encodeFunctionData, formatUnits } from 'viem';
import { ABI, addressBook, chainInfo, client, hasCode, markets, market, openedIds } from './chain.js';
import { config } from './config.js';

// The tools a connected assistant gets. Every tool works on the signed-in user's own wallet only (from the token,
// never from the assistant's input). "prepare_*" tools build transactions and hand back a link where the user
// signs them on app.backx.trade; nothing here signs or sends.

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const AMOUNT = z.string().regex(/^\d{1,18}(\.\d{1,18})?$/, 'a positive decimal number like "25" or "0.5"');

/** Decimal string → base units, rounded DOWN (money that is sent is always floored). */
export function toUnits(s, decimals) {
  const [i, f = ''] = String(s).split('.');
  if (decimals < 0) return BigInt(i) / 10n ** BigInt(-decimals);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
/** USD price per whole coin ↔ the contracts' unit (stable base units per 1e18 coin base units). */
const priceExp = (c, m) => c.stable.decimals + 18 - m.decimals;
const fmtPrice = (raw, c, m) => formatUnits(raw, priceExp(c, m));
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function guard(scope, auth, fn) {
  return async (args) => {
    if (!auth.scopes.includes(scope)) return fail(`This connection was not given "${scope}". Reconnect and tick it on the BackX consent page.`);
    try { return await fn(args); } catch (e) { return fail(String(e?.shortMessage || e?.message || e).slice(0, 400)); }
  };
}

async function launchChains() {
  const b = await addressBook();
  return b.chains.filter((c) => c.launch);
}

/** Store a prepared bundle for the sign page (15 minutes) and return the link. */
async function bundle(redis, auth, c, label, txs) {
  const pc = client(c);
  // Simulate in order until the first approval (later steps need it mined first; the sign page re-checks them).
  const steps = [];
  let blocked = false;
  for (const t of txs) {
    let sim = 'after previous step';
    if (!blocked) {
      try { await pc.call({ account: auth.wallet, to: t.to, data: t.data }); sim = 'ok'; } catch (e) { sim = `would fail: ${String(e?.shortMessage || e?.message).slice(0, 160)}`; }
      if (t.approval) blocked = true;
    }
    steps.push({ label: t.label, to: t.to, data: t.data, value: '0', simulation: sim });
  }
  const id = randomBytes(18).toString('base64url');
  await redis.set(`mcp:bundle:${id}`, JSON.stringify({
    wallet: auth.wallet, chainId: c.chainId, chain: c.name, label, steps, createdAt: Date.now(), client: auth.client_id,
  }), 'EX', 900);
  const url = new URL(config.signUrl);
  url.searchParams.set('b', id);
  return text({ chain: c.name, label, steps: steps.map(({ label: l, simulation }) => ({ step: l, simulation })), signHere: url.toString(),
    note: 'Open signHere in a browser where you are logged in to BackX. Nothing is sent until you approve each step in your wallet. The link expires in 15 minutes.' });
}

async function approvalIfNeeded(c, token, owner, spender, amount, label) {
  const have = await client(c).readContract({ address: token, abi: ABI.erc20, functionName: 'allowance', args: [owner, spender] });
  if (have >= amount) return [];
  return [{ label, approval: true, to: token, data: encodeFunctionData({ abi: ABI.erc20, functionName: 'approve', args: [spender, amount] }) }];
}

export function buildServer(auth, redis) {
  const server = new McpServer({ name: 'backx', version: '0.1.0' }, {
    instructions: 'BackX tools for the signed-in user\'s own account. Read tools need account:read. prepare_* tools build transactions the user signs on app.backx.trade; they never send anything. Leverage can lose the whole margin; nothing here is financial advice.',
  });
  const wallet = auth.wallet;

  server.registerTool('backx_status', {
    title: 'BackX status', description: 'Is BackX live, on which chains, and the user\'s wallet address.', inputSchema: {},
  }, guard('account:read', auth, async () => {
    const b = await addressBook();
    return text({ status: b.status, wallet, chains: b.chains.map((c) => ({ chainId: c.chainId, name: c.name, launch: c.launch, live: c.contracts.factory?.deployed ?? null, markets: c.contracts.factory?.markets ?? null })), skill: b.skill });
  }));

  server.registerTool('markets_list', {
    title: 'Markets', description: 'Coins listed on a chain with today\'s price and whether a Short side exists.',
    inputSchema: { chainId: z.number().int().describe('e.g. 4663 Robinhood Chain, 56 BNB Chain, 8453 Base, 42161 Arbitrum') },
  }, guard('account:read', auth, async ({ chainId }) => {
    const c = await chainInfo(chainId);
    const list = await markets(c, 50);
    if (!list.length) return text(`No markets on ${c.name} yet (contracts not live).`);
    const pc = client(c);
    const rows = await Promise.all(list.map(async (m) => ({
      symbol: m.symbol, coin: m.token, short: !!m.short,
      priceUsd: fmtPrice(await pc.readContract({ address: m.hedge, abi: ABI.manager, functionName: 'price' }), c, m),
    })));
    return text({ chain: c.name, markets: rows });
  }));

  server.registerTool('account_get', {
    title: 'My balances', description: 'The user\'s stable balance on each launch chain, plus $GAZZ and staking on Robinhood Chain.', inputSchema: {},
  }, guard('account:read', auth, async () => {
    const out = [];
    for (const c of await launchChains()) {
      const row = { chain: c.name, chainId: c.chainId };
      if (c.stable) row[c.stable.symbol] = formatUnits(await client(c).readContract({ address: c.stable.address, abi: ABI.erc20, functionName: 'balanceOf', args: [wallet] }), c.stable.decimals);
      const s = c.contracts.staking;
      if (s?.gazz) {
        row.GAZZ = formatUnits(await client(c).readContract({ address: s.gazz, abi: ABI.erc20, functionName: 'balanceOf', args: [wallet] }), 18);
        if (s.address && await hasCode(c, s.address)) {
          const r = (fn) => client(c).readContract({ address: s.address, abi: ABI.staking, functionName: fn, args: [wallet] });
          const [g, t, p, u, e] = await Promise.all([r('gazzOf'), r('tanksOf'), r('pointsOf'), r('unlockAt'), r('earned')]);
          row.staking = { gazz: formatUnits(g, 18), tanks: Number(t), points: formatUnits(p, 18), unlocks: u ? new Date(Number(u) * 1000).toISOString() : null, earned: c.stable ? formatUnits(e, c.stable.decimals) : e.toString() };
        } else row.staking = 'not live yet';
      }
      out.push(row);
    }
    return text({ wallet, chains: out });
  }));

  server.registerTool('rewards_get', {
    title: 'My rewards', description: 'Claimable USDC per issuer pool and from staking, per chain.', inputSchema: {},
  }, guard('account:read', auth, async () => {
    const out = [];
    for (const c of await launchChains()) {
      const pc = client(c);
      const pools = [];
      for (const m of await markets(c)) {
        for (const [side, v] of [['Long (USDC)', m.usdVault], [`Short (${m.symbol})`, m.tokenVault]]) {
          if (!v) continue;
          const p = await pc.readContract({ address: v, abi: ABI.vault, functionName: 'pendingRewards', args: [wallet] });
          if (p > 0n) pools.push({ market: m.symbol, side, claimable: formatUnits(p, c.stable.decimals) });
        }
      }
      const s = c.contracts.staking;
      let staking = null;
      if (s?.address && await hasCode(c, s.address)) staking = formatUnits(await pc.readContract({ address: s.address, abi: ABI.staking, functionName: 'earned', args: [wallet] }), c.stable.decimals);
      if (pools.length || staking) out.push({ chain: c.name, chainId: c.chainId, pools, staking });
    }
    return text(out.length ? out : 'Nothing to claim right now.');
  }));

  server.registerTool('positions_list', {
    title: 'My positions', description: 'The user\'s open Long and Short positions in one market.',
    inputSchema: { chainId: z.number().int(), coin: z.string().max(64).describe('coin symbol or address') },
  }, guard('account:read', auth, async ({ chainId, coin }) => {
    const c = await chainInfo(chainId);
    const m = await market(c, coin);
    const pc = client(c);
    const out = [];
    let complete = true;
    for (const [side, mgr] of [['Long', m.hedge], ['Short', m.short]]) {
      if (!mgr) continue;
      const { ids, complete: done } = await openedIds(redis, c, mgr, wallet);
      complete &&= done;
      for (const id of ids) {
        const p = await pc.readContract({ address: mgr, abi: ABI.manager, functionName: 'positions', args: [BigInt(id)] });
        if (p[0].toLowerCase() !== wallet || p[1] === 0) continue; // closed
        out.push({ side, id, leverage: `${p[1]}×`, margin: formatUnits(p[4], c.stable.decimals), openedAt: new Date(Number(p[2]) * 1000).toISOString(),
          takeProfitSet: p[8] > 0n, stopLossSet: p[10] > 0n });
      }
    }
    return text({ market: m.symbol, chain: c.name, positions: out, ...(complete ? {} : { note: 'Still scanning older blocks; call again for the rest.' }) });
  }));

  server.registerTool('prepare_open', {
    title: 'Prepare a trade', description: 'Build a Long (price up) or Short (price down) with leverage. The user signs it on app.backx.trade. Leverage can lose the whole margin.',
    inputSchema: {
      chainId: z.number().int(), coin: z.string().max(64), side: z.enum(['long', 'short']),
      amount: AMOUNT.describe('stable to pay, fees and gas included'), leverage: z.number().int().min(1).max(20),
      takeProfitUsd: AMOUNT.optional().describe('price per coin to take profit at'),
    },
  }, guard('trade:prepare', auth, async ({ chainId, coin, side, amount, leverage, takeProfitUsd }) => {
    const c = await chainInfo(chainId);
    const m = await market(c, coin);
    const mgr = side === 'long' ? m.hedge : m.short;
    if (!mgr) return fail(`${m.symbol} has no Short side yet.`);
    const amt = toUnits(amount, c.stable.decimals);
    if (amt === 0n) return fail('Amount must be above zero.');
    const max = Number(await client(c).readContract({ address: mgr, abi: ABI.manager, functionName: 'maxMFor', args: [amt] }));
    if (leverage > max) return fail(`Max leverage for this amount right now is ${max}×.`);
    const limit = takeProfitUsd ? toUnits(takeProfitUsd, priceExp(c, m)) : 0n;
    const txs = [
      ...(await approvalIfNeeded(c, c.stable.address, wallet, mgr, amt, `Approve ${amount} ${c.stable.symbol}`)),
      { label: `${side === 'long' ? 'Long' : 'Short'} ${m.symbol} ${leverage}× with ${amount} ${c.stable.symbol}`, to: mgr,
        data: encodeFunctionData({ abi: ABI.manager, functionName: 'open', args: [amt, leverage, 0n, limit] }) },
    ];
    return bundle(redis, auth, c, `Open ${side} ${m.symbol}`, txs);
  }));

  server.registerTool('prepare_close', {
    title: 'Prepare a close', description: 'Close one of the user\'s positions (id from positions_list).',
    inputSchema: { chainId: z.number().int(), coin: z.string().max(64), side: z.enum(['long', 'short']), id: z.string().regex(/^\d{1,30}$/) },
  }, guard('trade:prepare', auth, async ({ chainId, coin, side, id }) => {
    const c = await chainInfo(chainId);
    const m = await market(c, coin);
    const mgr = side === 'long' ? m.hedge : m.short;
    const p = await client(c).readContract({ address: mgr, abi: ABI.manager, functionName: 'positions', args: [BigInt(id)] });
    if (p[0].toLowerCase() !== wallet) return fail('That position is not yours or is already closed.');
    return bundle(redis, auth, c, `Close ${side} ${m.symbol} #${id}`, [{ label: `Close position #${id}`, to: mgr, data: encodeFunctionData({ abi: ABI.manager, functionName: 'close', args: [BigInt(id), 0n] }) }]);
  }));

  server.registerTool('prepare_issue', {
    title: 'Prepare issuing', description: 'Put stable (backs Longs) or the coin itself (backs Shorts) into a market\'s reserve to earn USDC. Not risk-free.',
    inputSchema: { chainId: z.number().int(), coin: z.string().max(64), side: z.enum(['long', 'short']), amount: AMOUNT },
  }, guard('issue:prepare', auth, async ({ chainId, coin, side, amount }) => {
    const c = await chainInfo(chainId);
    const m = await market(c, coin);
    const vault = side === 'long' ? m.usdVault : m.tokenVault;
    if (!vault) return fail(`${m.symbol} has no Short reserve yet.`);
    const asset = side === 'long' ? c.stable : { address: m.token, decimals: m.decimals, symbol: m.symbol };
    const amt = toUnits(amount, asset.decimals);
    if (amt === 0n) return fail('Amount must be above zero.');
    const txs = [
      ...(await approvalIfNeeded(c, asset.address, wallet, vault, amt, `Approve ${amount} ${asset.symbol}`)),
      { label: `Issue ${amount} ${asset.symbol} into ${m.symbol} ${side === 'long' ? 'Long' : 'Short'} reserve`, to: vault, data: encodeFunctionData({ abi: ABI.vault, functionName: 'deposit', args: [amt, wallet] }) },
    ];
    return bundle(redis, auth, c, `Issue ${asset.symbol}`, txs);
  }));

  server.registerTool('prepare_withdraw', {
    title: 'Prepare a reserve withdrawal', description: 'Take issued capital back (only what is free right now), to the user\'s own wallet.',
    inputSchema: { chainId: z.number().int(), coin: z.string().max(64), side: z.enum(['long', 'short']), amount: AMOUNT },
  }, guard('issue:prepare', auth, async ({ chainId, coin, side, amount }) => {
    const c = await chainInfo(chainId);
    const m = await market(c, coin);
    const vault = side === 'long' ? m.usdVault : m.tokenVault;
    if (!vault) return fail(`${m.symbol} has no Short reserve.`);
    const dec = side === 'long' ? c.stable.decimals : m.decimals;
    const amt = toUnits(amount, dec);
    const free = await client(c).readContract({ address: vault, abi: ABI.vault, functionName: 'maxWithdraw', args: [wallet] });
    if (amt > free) return fail(`Only ${formatUnits(free, dec)} is free right now; the rest comes back as positions close (requestRedeem on app.backx.trade).`);
    return bundle(redis, auth, c, 'Withdraw', [{ label: `Withdraw ${amount} to your wallet`, to: vault, data: encodeFunctionData({ abi: ABI.vault, functionName: 'withdraw', args: [amt, wallet, wallet] }) }]);
  }));

  const stakingOf = async () => {
    const c = (await addressBook()).chains.find((x) => x.contracts.staking);
    const s = c?.contracts.staking;
    if (!s?.address || !(await hasCode(c, s.address))) throw new Error('Staking is not live yet.');
    return { c, s };
  };

  server.registerTool('prepare_stake', {
    title: 'Prepare staking', description: '$GAZZ and/or Gazz Tanks in one transaction (Robinhood Chain). Locks everything staked for 90 days from now. Rewards: 10 % of platform revenue in USDC.',
    inputSchema: { gazz: AMOUNT.optional(), tankIds: z.array(z.number().int().min(0).max(100_000)).max(50).optional() },
  }, guard('stake:prepare', auth, async ({ gazz, tankIds = [] }) => {
    const { c, s } = await stakingOf();
    const amt = gazz ? toUnits(gazz, 18) : 0n;
    if (amt === 0n && !tankIds.length) return fail('Give $GAZZ, Tank ids or both.');
    const pc = client(c);
    for (const id of tankIds) {
      const o = await pc.readContract({ address: s.tanks, abi: ABI.erc721, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null);
      if (o?.toLowerCase() !== wallet) return fail(`Tank #${id} is not in your wallet.`);
    }
    const txs = amt ? await approvalIfNeeded(c, s.gazz, wallet, s.address, amt, `Approve ${gazz} $GAZZ (once)`) : [];
    if (tankIds.length && !(await pc.readContract({ address: s.tanks, abi: ABI.erc721, functionName: 'isApprovedForAll', args: [wallet, s.address] }))) {
      txs.push({ label: 'Allow BackX staking to hold your Tanks (once)', approval: true, to: s.tanks, data: encodeFunctionData({ abi: ABI.erc721, functionName: 'setApprovalForAll', args: [s.address, true] }) });
    }
    txs.push({ label: `Stake ${gazz ?? 0} $GAZZ${tankIds.length ? ` + ${tankIds.length} Tank(s)` : ''} (locked 90 days)`, to: s.address,
      data: encodeFunctionData({ abi: ABI.staking, functionName: 'stake', args: [amt, tankIds.map(BigInt)] }) });
    return bundle(redis, auth, c, 'Stake', txs);
  }));

  server.registerTool('prepare_unstake', {
    title: 'Prepare unstaking', description: 'Take staked $GAZZ and/or Tanks back after the 90-day lock. Earned USDC stays claimable.',
    inputSchema: { gazz: AMOUNT.optional(), tankIds: z.array(z.number().int().min(0).max(100_000)).max(50).optional() },
  }, guard('stake:prepare', auth, async ({ gazz, tankIds = [] }) => {
    const { c, s } = await stakingOf();
    const pc = client(c);
    const until = Number(await pc.readContract({ address: s.address, abi: ABI.staking, functionName: 'unlockAt', args: [wallet] }));
    if (until * 1000 > Date.now()) return fail(`Locked until ${new Date(until * 1000).toISOString()}.`);
    const amt = gazz ? toUnits(gazz, 18) : 0n;
    return bundle(redis, auth, c, 'Unstake', [{ label: `Unstake ${gazz ?? 0} $GAZZ${tankIds.length ? ` + ${tankIds.length} Tank(s)` : ''}`, to: s.address,
      data: encodeFunctionData({ abi: ABI.staking, functionName: 'unstake', args: [amt, tankIds.map(BigInt)] }) }]);
  }));

  server.registerTool('prepare_claim_all', {
    title: 'Prepare Claim all', description: 'One transaction per chain that claims every issuer pool and staking reward to the user\'s own wallet.',
    inputSchema: { chainId: z.number().int() },
  }, guard('claim:prepare', auth, async ({ chainId }) => {
    const c = await chainInfo(chainId);
    const pc = client(c);
    const calls = [];
    for (const m of await markets(c)) {
      for (const v of [m.usdVault, m.tokenVault].filter(Boolean)) {
        if ((await pc.readContract({ address: v, abi: ABI.vault, functionName: 'pendingRewards', args: [wallet] })) > 0n) {
          calls.push({ target: v, allowFailure: true, callData: encodeFunctionData({ abi: ABI.vault, functionName: 'claimRewardsFor', args: [wallet] }) });
        }
      }
    }
    const s = c.contracts.staking;
    if (s?.address && await hasCode(c, s.address) && (await pc.readContract({ address: s.address, abi: ABI.staking, functionName: 'earned', args: [wallet] })) > 0n) {
      calls.push({ target: s.address, allowFailure: true, callData: encodeFunctionData({ abi: ABI.staking, functionName: 'claimFor', args: [wallet] }) });
    }
    if (!calls.length) return text(`Nothing to claim on ${c.name}.`);
    return bundle(redis, auth, c, 'Claim all', [{ label: `Claim ${calls.length} reward(s) to your wallet`, to: MULTICALL3,
      data: encodeFunctionData({ abi: ABI.multicall, functionName: 'aggregate3', args: [calls] }) }]);
  }));

  return server;
}

