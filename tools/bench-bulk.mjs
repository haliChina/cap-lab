// Compiled vs interpreted hashwx, with the right context for each mode.
//
//   compiled   : hashwx_alloc(1) -> inner wasm -> begin / inner() / final  (what the widget uses)
//   interpreted: hashwx_alloc(0) -> hashwx_exec(ctx, nonce)               (what we have been using)
//
//   node bench-bulk.mjs [seconds]
import { pathToFileURL } from "node:url";

const CORE = process.env.CAP_CORE || "../cap/standalone/node_modules/capjs-core/src/hashwx.js";
const core = await import(pathToFileURL(CORE).href);
const BUDGET = Number(process.argv[2] || 5) * 1000;
const N = 65536;
const D = 250_000;
const lim = BigInt.asUintN(64, core.hashwxTarget(D));
const chal = new Uint8Array(32).fill(7);
const seedFor = (b) => core.hashwxSeed(chal, BigInt(b));

const st = await core.hashwxReady();
const ex = st.exports;

const iCtx = ex.hashwx_alloc(0);
const seedPtr = ex.hashwx_seed(iCtx);

const cCtx = ex.hashwx_alloc(1);
new Uint8Array(ex.memory.buffer, seedPtr, 32).set(seedFor(0));
ex.hashwx_make(cCtx, seedPtr);
const innerBytes = new Uint8Array(
  ex.memory.buffer, ex.hashwx_module(cCtx), ex.hashwx_module_size(cCtx),
).slice();
const inner = new WebAssembly.Instance(new WebAssembly.Module(innerBytes), {
  env: { memory: ex.memory },
}).exports.exec;
const regPtr = ex.hashwx_registers(cCtx);
const memPtr = ex.hashwx_memory(cCtx);
console.log("inner wasm " + innerBytes.length + "B | regPtr=" + regPtr + " memPtr=" + memPtr + "\n");

new Uint8Array(ex.memory.buffer, seedPtr, 32).set(seedFor(0));
ex.hashwx_make(iCtx, seedPtr);
const viaInterp = BigInt.asUintN(64, ex.hashwx_exec(iCtx, 12345n));
new Uint8Array(ex.memory.buffer, seedPtr, 32).set(seedFor(0));
ex.hashwx_make(cCtx, seedPtr);
ex.hashwx_exec_begin(cCtx, 12345n);
inner(regPtr, memPtr);
const viaComp = BigInt.asUintN(64, ex.hashwx_exec_final(cCtx));
console.log("cross-check nonce=12345: interpreted=" + viaInterp + " compiled=" + viaComp + " agree=" + (viaInterp === viaComp) + "\n");

function bench(label, mode, budget) {
  const lim2 = budget || BUDGET;
  const t0 = Date.now();
  let n = 0;
  for (let block = 0; Date.now() - t0 < lim2; block++) {
    const base = BigInt.asUintN(64, BigInt(block) * BigInt(N));
    new Uint8Array(ex.memory.buffer, seedPtr, 32).set(seedFor(block));
    if (mode === "compiled") {
      ex.hashwx_make(cCtx, seedPtr);
      for (let k = 0n; k < BigInt(N); k++) {
        n++;
        const nonce = BigInt.asUintN(64, base + k);
        ex.hashwx_exec_begin(cCtx, nonce);
        inner(regPtr, memPtr);
        if (BigInt.asUintN(64, ex.hashwx_exec_final(cCtx)) <= lim) break;
      }
    } else {
      ex.hashwx_make(iCtx, seedPtr);
      const seed = seedFor(block);
      for (let k = 0n; k < BigInt(N); k++) {
        n++;
        if (core.hashwxHash({ exports: ex, ctx: iCtx, seedPtr }, seed, base + k) <= lim) break;
      }
    }
  }
  const dt = Math.max(1, Date.now() - t0);
  const rate = Math.round((n / dt) * 1000);
  console.log(label.padEnd(38) + " " + String(rate).padStart(9) + " hashes/s  (" + n + " in " + dt + "ms)");
  return rate;
}

const a1 = bench("compiled   begin+inner+final", "compiled");
const b1 = bench("interpreted hashwxExec per nonce", "interpreted");
bench("compiled   begin+inner+final", "compiled");
bench("interpreted hashwxExec per nonce", "interpreted");
console.log("\nratio compiled/interpreted: " + (a1 / b1).toFixed(2) + "x");
