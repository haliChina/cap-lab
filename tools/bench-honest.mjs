// Honest comparison: the generated inner module is seed-specialised, so it must be
// recompiled after every hashwx_make (i.e. once per 65536-nonce block). Every hit
// is confirmed with the interpreted path before it counts.
import { pathToFileURL } from "node:url";
const CORE = process.env.CAP_CORE || "../cap/standalone/node_modules/capjs-core/src/hashwx.js";
const core = await import(pathToFileURL(CORE).href);
const ex = (await core.hashwxReady()).exports;

const BUDGET = Number(process.argv[2] || 6) * 1000;
const N = 65536, D = 250000;
const lim = BigInt.asUintN(64, core.hashwxTarget(D));
const chal = new Uint8Array(32).fill(7);
const iCtx = ex.hashwx_alloc(0), iSeed = ex.hashwx_seed(iCtx);
const cCtx = ex.hashwx_alloc(1), cSeed = ex.hashwx_seed(cCtx);
const regPtr = ex.hashwx_registers(cCtx), memPtr = ex.hashwx_memory(cCtx);
const seed = (b) => core.hashwxSeed(chal, BigInt(b));
const put = (ctx, ptr, b) => { new Uint8Array(ex.memory.buffer, ptr, 32).set(seed(b)); ex.hashwx_make(ctx, ptr); };
const loadInner = () => new WebAssembly.Instance(new WebAssembly.Module(
  new Uint8Array(ex.memory.buffer, ex.hashwx_module(cCtx), ex.hashwx_module_size(cCtx)).slice(),
), { env: { memory: ex.memory } }).exports.exec;

let recompiles = 0;
function runCompiled(budget) {
  const t0 = Date.now();
  let n = 0, hits = 0, bad = 0;
  for (let block = 0; Date.now() - t0 < budget; block++) {
    put(cCtx, cSeed, block);
    const inner = loadInner(); recompiles++;
    const base = BigInt.asUintN(64, BigInt(block) * BigInt(N));
    for (let k = 0n; k < BigInt(N); k++) {
      n++;
      const nonce = BigInt.asUintN(64, base + k);
      ex.hashwx_exec_begin(cCtx, nonce);
      inner(regPtr, memPtr);
      if (BigInt.asUintN(64, ex.hashwx_exec_final(cCtx)) <= lim) {
        put(iCtx, iSeed, block);
        const truth = BigInt.asUintN(64, ex.hashwx_exec(iCtx, nonce));
        if (truth <= lim) hits++; else bad++;
      }
    }
  }
  const dt = Math.max(1, Date.now() - t0);
  console.log("compiled (recompile/block) " + String(Math.round((n / dt) * 1000)).padStart(9) +
    " hashes/s  | " + n + " in " + dt + "ms | hits " + hits + " bogus " + bad + " | recompiles " + recompiles);
  return n / dt;
}

function runInterpreted(budget) {
  const t0 = Date.now();
  let n = 0, hits = 0;
  for (let block = 0; Date.now() - t0 < budget; block++) {
    put(iCtx, iSeed, block);
    const s = seed(block);
    const base = BigInt.asUintN(64, BigInt(block) * BigInt(N));
    for (let k = 0n; k < BigInt(N); k++) {
      n++;
      if (core.hashwxHash({ exports: ex, ctx: iCtx, seedPtr: iSeed }, s, base + k) <= lim) hits++;
    }
  }
  const dt = Math.max(1, Date.now() - t0);
  console.log("interpreted               " + String(Math.round((n / dt) * 1000)).padStart(9) +
    " hashes/s  | " + n + " in " + dt + "ms | hits " + hits);
  return n / dt;
}

const a = runCompiled(BUDGET);
const b = runInterpreted(BUDGET);
console.log("\nreal ratio compiled/interpreted: " + (a / b).toFixed(2) + "x");
