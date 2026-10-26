import { createPublicClient, http, parseAbi } from 'viem';
import { config } from './config.js';

// Everything about money is read straight from the chain (owner rule: on-chain state is the source of truth).
// Addresses come from the public address book (agents.json) and the factory, never from the user or the assistant.

export const ABI = {
  erc20: parseAbi([
    'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ]),
  erc721: parseAbi(['function isApprovedForAll(address,address) view returns (bool)', 'function setApprovalForAll(address,bool)', 'function ownerOf(uint256) view returns (address)']),
  factory: parseAbi([
    'function marketCount() view returns (uint256)', 'function tokens(uint256) view returns (address)',
    'function setOf(address) view returns ((address hedge, address usdVault, address hedgeFund, address short, address tokenVault, address shortFund))',
  ]),
  manager: parseAbi([
    'function price() view returns (uint256)', 'function maxMFor(uint256) view returns (uint8)', 'function paused() view returns (bool)',
    'function positions(uint256) view returns (address owner, uint8 m, uint40 openedAt, uint64 gas, uint128 stake, uint128 lent, uint128 amount, uint128 lentUsd, uint128 limitValue, uint128 stressUsd, uint128 stopValue)',
    'function threshold(uint256) view returns (uint256)', 'function isLiquidatable(uint256) view returns (bool)',
    'function open(uint256 amount, uint8 m, uint256 minOut, uint256 limitPrice) returns (uint256)',
    'function close(uint256 id, uint256 limit)', 'function setLimit(uint256 id, uint256 limitPrice)', 'function setStop(uint256 id, uint256 stopPrice)',
    'event Opened(uint256 indexed id, address indexed owner, uint8 m, uint256 stake, uint256 lent, uint256 amount, uint256 limitValue)',
  ]),
  vault: parseAbi([
    'function pendingRewards(address) view returns (uint256)', 'function maxWithdraw(address) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)',
    'function deposit(uint256 assets, address receiver) returns (uint256)', 'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
    'function claimRewardsFor(address owner) returns (uint256)',
  ]),
  staking: parseAbi([
    'function earned(address) view returns (uint256)', 'function pointsOf(address) view returns (uint256)', 'function gazzOf(address) view returns (uint256)',
    'function tanksOf(address) view returns (uint256)', 'function unlockAt(address) view returns (uint256)', 'function tankPoints() view returns (uint256)',
    'function tankOwner(uint256) view returns (address)',
    'function stake(uint256 amount, uint256[] tankIds)', 'function unstake(uint256 amount, uint256[] tankIds)', 'function claimFor(address who) returns (uint256)',
  ]),
  multicall: parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']),
};

let book = null, bookAt = 0;
/** The public address book, cached 5 minutes. */
export async function addressBook() {
  if (book && Date.now() - bookAt < 300_000) return book;
  const r = await fetch(config.agentsUrl, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('agents.json unavailable');
  book = await r.json();
  bookAt = Date.now();
  return book;
}

export async function chainInfo(chainId) {
  const b = await addressBook();
  const c = b.chains.find((x) => x.chainId === Number(chainId));
  if (!c) throw new Error(`Unknown chain ${chainId}. Known: ${b.chains.map((x) => `${x.chainId} ${x.name}`).join(', ')}`);
  return c;
}

const clients = new Map();
export function client(c) {
  if (!clients.has(c.chainId)) clients.set(c.chainId, createPublicClient({ transport: http(c.rpc, { timeout: 10_000, batch: { batchSize: 25 } }) }));
  return clients.get(c.chainId);
}

export const hasCode = async (c, address) => !!address && ((await client(c).getCode({ address })) ?? '0x').length > 2;

/** The coins listed on a chain with their contract sets. Empty until the factory is live. */
export async function markets(c, limit = 100) {
  const f = c.contracts.factory?.address;
  if (!f || !(await hasCode(c, f))) return [];
  const pc = client(c);
  const n = Number(await pc.readContract({ address: f, abi: ABI.factory, functionName: 'marketCount' }));
  const tokens = await Promise.all(Array.from({ length: Math.min(n, limit) }, (_, i) => pc.readContract({ address: f, abi: ABI.factory, functionName: 'tokens', args: [BigInt(i)] })));
  return Promise.all(tokens.map(async (token) => {
    const [set, symbol, decimals] = await Promise.all([
      pc.readContract({ address: f, abi: ABI.factory, functionName: 'setOf', args: [token] }),
      pc.readContract({ address: token, abi: ABI.erc20, functionName: 'symbol' }).catch(() => '?'),
      pc.readContract({ address: token, abi: ABI.erc20, functionName: 'decimals' }).catch(() => 18),
    ]);
    return { token: token.toLowerCase(), symbol, decimals: Number(decimals), ...lower(set) };
  }));
}
const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v === ZERO ? null : v.toLowerCase()]));

/** One market by coin address or symbol (case-insensitive). */
export async function market(c, coin) {
  const list = await markets(c);
  const q = String(coin).toLowerCase();
  const m = list.find((x) => x.token === q) ?? list.filter((x) => x.symbol.toLowerCase() === q)[0];
  if (!m) throw new Error(list.length ? `No market for ${coin} on ${c.name}. Listed: ${list.map((x) => x.symbol).join(', ')}` : `No markets on ${c.name} yet (contracts not live).`);
  return m;
}

/**
 * Position ids a wallet opened on one manager, from Opened logs (owner is indexed). Scans forward in 10k-block
 * chunks and remembers how far it got per wallet in Redis, so each call is cheap after the first.
 */
export async function openedIds(redis, c, manager, wallet) {
  const pc = client(c);
  const key = `mcp:pos:${c.chainId}:${manager}:${wallet}`;
  const st = JSON.parse((await redis.get(key)) || 'null') ?? { from: null, ids: [] };
  const latest = await pc.getBlockNumber();
  let from = st.from != null ? BigInt(st.from) : (latest > 3_000_000n ? latest - 3_000_000n : 0n);
  const event = ABI.manager.find((x) => x.type === 'event' && x.name === 'Opened');
  for (let i = 0; i < 40 && from <= latest; i++) {
    const to = from + 9_999n > latest ? latest : from + 9_999n;
    const logs = await pc.getLogs({ address: manager, event, args: { owner: wallet }, fromBlock: from, toBlock: to });
    for (const l of logs) st.ids.push(l.args.id.toString());
    from = to + 1n;
  }
  st.from = from.toString();
  st.ids = [...new Set(st.ids)];
  await redis.set(key, JSON.stringify(st), 'EX', 30 * 86400);
  return { ids: st.ids, complete: from > latest };
}
