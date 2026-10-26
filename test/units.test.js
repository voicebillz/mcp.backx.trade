import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure helpers only (no Redis, no network). Config needs env to load, so set harmless values first.
process.env.PUBLIC_URL ??= 'http://127.0.0.1:1';
process.env.REDIS_URL ??= 'redis://127.0.0.1:1';
process.env.API_GRANT_PUBLIC_KEY ??= 'MCowBQYDK2VwAyEAkAlGW5Gx8z2MPsH9Zahcixds5Kg0pY9bz0DyBez50Cs=';
const { toUnits } = await import('../src/tools.js');

test('amounts round DOWN to the token decimals', () => {
  assert.equal(toUnits('25', 6), 25_000_000n);
  assert.equal(toUnits('0.1234567', 6), 123_456n);
  assert.equal(toUnits('1.5', 18), 1_500_000_000_000_000_000n);
  assert.equal(toUnits('3', 0), 3n);
});

test('a USD price per coin becomes stable units per 1e18 coin units', () => {
  // USDC 6 decimals, coin 8 decimals (e.g. cbBTC): exponent 6 + 18 − 8 = 16.
  assert.equal(toUnits('65000', 16), 650_000_000_000_000_000_000n);
});
