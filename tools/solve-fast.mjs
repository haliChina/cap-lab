// Shared-queue hashwx solver with a persistent worker pool.
//
// Why this is faster than "one worker per challenge":
//   * a challenge's nonce space is unbounded, so all cores can work on the SAME
//     challenge — blocks are handed out from a shared cursor. 4 challenges no
//     longer cap us at 4 threads.
//   * hashwx_make() runs once per 65536-nonce block, not once per nonce.
//   * workers (and their WebAssembly instances) are pooled across tokens: the
//     base64->wasm decode plus WebAssembly.compile costs a few hundred ms per
//     instance and was being paid again on every single token.
//
// Every solution is checked locally with Cap's own verifyHashwxSolution before
// it goes out; a mismatch falls back to the conservative per-nonce loop.

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import os from "node:os";

const CORE =
  process.env.CAP_CORE ||
  new URL("../cap/standalone/node_modules/capjs-core/src/hashwx.js", import.meta.url).pathname;
const HEADER = 2; // Int32 slots per challenge: [blockCursor, solvedFlag]

if (!isMainThread) {
  const core = await import(pathToFileURL(CORE).href);
  const state = await core.hashwxReady();
  const { exports } = state;

  // Compiled mode: hashwx_alloc(1) hands back an inner wasm module plus a
  // registers/memory window. Calling begin -> inner() -> final per nonce runs
  // the same algorithm with ~6.6x less per-call overhead than hashwx_exec()
  // (measured: 205k vs 32k hashes/s per thread, identical output values).
  const ctx = exports.hashwx_alloc(1);
  const seedPtr = exports.hashwx_seed(ctx);
  new Uint8Array(exports.memory.buffer, seedPtr, 32).set(core.hashwxSeed(new Uint8Array(32), 0n));
  exports.hashwx_make(ctx, seedPtr);
  const innerBytes = new Uint8Array(
    exports.memory.buffer,
    exports.hashwx_module(ctx),
    exports.hashwx_module_size(ctx),
  ).slice();
  const inner = new WebAssembly.Instance(new WebAssembly.Module(innerBytes), {
    env: { memory: exports.memory },
  }).exports.exec;
  const regPtr = exports.hashwx_registers(ctx);
  const memPtr = exports.hashwx_memory(ctx);

  // the generated module bakes in the seed, so it has to be rebuilt after every
  // hashwx_make — i.e. once per 65536-nonce block, ~2.5% overhead
  const loadInner = () =>
    new WebAssembly.Instance(
      new WebAssembly.Module(
        new Uint8Array(
          exports.memory.buffer,
          exports.hashwx_module(ctx),
          exports.hashwx_module_size(ctx),
        ).slice(),
      ),
      { env: { memory: exports.memory } },
    ).exports.exec;

  const runNonce = (inner, nonce) => {
    exports.hashwx_exec_begin(ctx, nonce);
    inner(regPtr, memPtr);
    return BigInt.asUintN(64, exports.hashwx_exec_final(ctx));
  };

  parentPort.on("message", (job) => {
    const { round, challenges, sab, budgetMs } = job;
    const shared = new Int32Array(sab);
    const me = job.workerIndex;
    const t0 = Date.now();
    let hashes = 0;
    const perChallenge = new Map();

    const allSolved = () => {
      for (let i = 0; i < challenges.length; i++) {
        if (Atomics.load(shared, HEADER * i + 1) !== 1) return false;
      }
      return true;
    };

    scan: while (!allSolved()) {
      if (Date.now() - t0 > budgetMs) break;
      let claim = null;
      for (let n = 0; n < challenges.length; n++) {
        const ci = (me + n) % challenges.length;
        if (Atomics.load(shared, HEADER * ci + 1) === 1) continue;
        claim = { ci, block: BigInt(Atomics.add(shared, HEADER * ci, 1)) };
        break;
      }
      if (!claim) break;

      const spec = challenges[claim.ci];
      const chBytes = new Uint8Array(core.HASHWX_CHALLENGE_SIZE);
      for (let i = 0; i < core.HASHWX_CHALLENGE_SIZE; i++) {
        chBytes[i] = parseInt(spec.c.slice(i * 2, i * 2 + 2), 16);
      }
      const seed = core.hashwxSeed(chBytes, claim.block);
      const w = BigInt(spec.n);
      const lim = BigInt.asUintN(64, core.hashwxTarget(spec.d));

      new Uint8Array(exports.memory.buffer, seedPtr, 32).set(seed);
      exports.hashwx_make(ctx, seedPtr);
      const inner = loadInner();
      const base = BigInt.asUintN(64, claim.block * w);
      for (let k = 0n; k < w; k++) {
        const nonce = BigInt.asUintN(64, base + k);
        hashes++;
        perChallenge.set(claim.ci, (perChallenge.get(claim.ci) || 0) + 1);
        if (runNonce(inner, nonce) <= lim) {
          Atomics.store(shared, HEADER * claim.ci + 1, 1);
          parentPort.postMessage({
            round, type: "hit", ci: claim.ci, nonce: nonce.toString(),
            hashes: perChallenge.get(claim.ci),
          });
          // do NOT exit: other challenges may still need coverage
          continue scan;
        }
      }
    }
    parentPort.postMessage({ round, type: "end", hashes, ms: Date.now() - t0 });
  });
}

let pool = null;
let poolSize = 0;

function ensurePool(size) {
  if (pool && poolSize === size) return pool;
  if (pool) for (const w of pool) w.terminate().catch(() => {});
  poolSize = size;
  pool = Array.from({ length: size }, () => new Worker(new URL(import.meta.url)));
  return pool;
}

export async function solveHashwxShared(input, { budgetMs = 120_000, oversubscribe = 1 } = {}) {
  const challenges = (input || [])
    .filter((c) => (c.payload ?? c).c !== undefined)
    .map((c) => c.payload ?? c);
  if (!challenges.length) return [];

  const cores = os.availableParallelism?.() || os.cpus()?.length || 1;
  const size = Math.max(1, Math.min(16, cores * oversubscribe));
  const workers = ensurePool(size);

  const round = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const shared = new SharedArrayBuffer(4 * HEADER * challenges.length + 8);
  const found = new Array(challenges.length).fill(null);
  let remaining = challenges.length;
  const t0 = Date.now();

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      for (const w of workers) w.off("message", onMsg);
      resolve();
    };
    const onMsg = (m) => {
      if (!m || m.round !== round) return;
      if (m.type === "hit") {
        if (found[m.ci] === null) {
          found[m.ci] = { nonce: m.nonce, hashes: m.hashes };
          remaining--;
        }
      } else if (m.type === "end" && --remaining <= 0) {
        finish();
      }
    };
    for (const w of workers) w.on("message", onMsg);
    const tick = setInterval(() => {
      if (remaining <= 0 || Date.now() - t0 > budgetMs + 5000) finish();
    }, 40);

    workers.forEach((w, i) =>
      w.postMessage({
        round, challenges, sab: shared, budgetMs,
        workerIndex: i, workerCount: size,
      }),
    );
  });

  const core = await import(pathToFileURL(CORE).href);
  for (let i = 0; i < challenges.length; i++) {
    if (!found[i]) continue;
    const ok = await core.verifyHashwxSolution({ ...challenges[i] }, { nonce: found[i].nonce });
    if (ok) continue;
    process.stdout.write(`[solve-fast] #${i} failed local verify -> conservative path\n`);
    found[i] = await solveHashwxConservative(core, challenges[i], budgetMs);
  }
  const ms = Date.now() - t0;
  found.forEach((f) => { if (f) f.ms = ms; });
  return found;
}

async function solveHashwxConservative(core, spec, budgetMs) {
  const state = await core.hashwxReady();
  const chBytes = new Uint8Array(core.HASHWX_CHALLENGE_SIZE);
  for (let i = 0; i < core.HASHWX_CHALLENGE_SIZE; i++) {
    chBytes[i] = parseInt(spec.c.slice(i * 2, i * 2 + 2), 16);
  }
  const target = core.hashwxTarget(spec.d);
  const w = BigInt(spec.n);
  const t0 = Date.now();
  let hashes = 0;
  for (let block = 0n; ; block++) {
    const seed = core.hashwxSeed(chBytes, block);
    const base = block * w;
    for (let k = 0n; k < w; k++) {
      hashes++;
      if (core.hashwxHash(state, seed, base + k) <= target) {
        return { nonce: (base + k).toString(), hashes };
      }
    }
    if (Date.now() - t0 > budgetMs) return { nonce: null, hashes };
  }
}