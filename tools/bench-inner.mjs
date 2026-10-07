// Inner-loop micro-benchmark: same wasm, three ways to walk one block.
//   a) per-nonce make (Cap's own hashwxHash path)
//   b) make once per block, asUintN on every result, BigInt nonce
//   c) make once per block, signed compare, Number nonce (fewer allocations)
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const CORE = process.env.CAP_CORE || "../cap/standalone/node_modules/capjs-core/src/hashwx.js";
const core = await import(pathToFileURL(CORE).href);
const state = await core.hashwxReady();
const { exports, ctx, seedPtr } = state;

const N = 65536; // one block
const D = 250_000; // the difficulty the server uses by default
const lim = BigInt.asUintN(64, core.hashwxTarget(D));
const chal = new Uint8Array(32).fill(randomBytes(1)[0]);
const seedFor = (block) => core.hashwxSeed(chal, BigInt(block));

function bench(label, fn, ms = 4000) {
  fn(500); // warm up
  const t0 = Date.now();
  const n = fn(ms);
  const dt = Date.now() - t0;
  console.log(`${label.padEnd(36)} ${Math.round((n / dt) * 1000).toString().padStart(9)} hashes/s  (${n} in ${dt}ms)`);
}

bench("a) core.hashwxHash (make/nonce)", (budget) => {
  const t0 = Date.now();
  let n = 0;
  for (let block = 0; Date.now() - t0 < budget; block++) {
    const seed = seedFor(block);
    for (let k = 0; k < N; k++) {
      n++;
      if (core.hashwxHash(state, seed, BigInt(block) * BigInt(N) + BigInt(k)) <= lim) return n;
    }
  }
  return n;
});

bench("b) make/block + asUintN", (budget) => {
  const t0 = Date.now();
  let n = 0;
  for (let block = 0; Date.now() - t0 < budget; block++) {
    new Uint8Array(exports.memory.buffer, seedPtr, 32).set(seedFor(block));
    exports.hashwx_make(ctx, seedPtr);
    const base = BigInt.asUintN(64, BigInt(block) * BigInt(N));
    for (let k = 0; k < N; k++) {
      n++;
      const h = BigInt.asUintN(64, exports.hashwx_exec(ctx, BigInt.asUintN(64, base + BigInt(k))));
      if (h <= lim) return n;
    }
  }
  return n;
});

bench("c) make/block + signed + Number", (budget) => {
  const t0 = Date.now();
  let n = 0;
  for (let block = 0; Date.now() - t0 < budget; block++) {
    new Uint8Array(exports.memory.buffer, seedPtr, 32).set(seedFor(block));
    exports.hashwx_make(ctx, seedPtr);
    let nonce = block * N;
    for (let k = 0; k < N; k++, nonce++) {
      n++;
      const h = exports.hashwx_exec(ctx, nonce); // signed i64 as BigInt
      if (h >= 0n && h <= lim) return n;
    }
  }
  return n;
});