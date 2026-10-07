// Is the generated inner module seed-specific?
// For a few blocks, compare: interpreted hashwxExec vs compiled-with-reused-inner
// vs compiled-with-inner-recompiled-after-each-make.
import { pathToFileURL } from "node:url";
const CORE = process.env.CAP_CORE || "../cap/standalone/node_modules/capjs-core/src/hashwx.js";
const core = await import(pathToFileURL(CORE).href);
const ex = (await core.hashwxReady()).exports;
const chal = new Uint8Array(32).fill(7);
const iCtx = ex.hashwx_alloc(0);
const cCtx = ex.hashwx_alloc(1);
const iSeed = ex.hashwx_seed(iCtx);
const cSeed = ex.hashwx_seed(cCtx);

const loadInner = () => {
  const b = new Uint8Array(ex.memory.buffer, ex.hashwx_module(cCtx), ex.hashwx_module_size(cCtx)).slice();
  return new WebAssembly.Instance(new WebAssembly.Module(b), { env: { memory: ex.memory } }).exports.exec;
};
const setSeed = (ctx, ptr, block) => {
  new Uint8Array(ex.memory.buffer, ptr, 32).set(core.hashwxSeed(chal, BigInt(block)));
  ex.hashwx_make(ctx, ptr);
};

setSeed(cCtx, cSeed, 0);
const reused = loadInner();
const regPtr = ex.hashwx_registers(cCtx), memPtr = ex.hashwx_memory(cCtx);
console.log("block | interpreted | compiled(reuse inner) | match");
for (let block = 0; block < 4; block++) {
  setSeed(iCtx, iSeed, block);
  const a = BigInt.asUintN(64, ex.hashwx_exec(iCtx, 777n));
  setSeed(cCtx, cSeed, block);
  ex.hashwx_exec_begin(cCtx, 777n);
  reused(regPtr, memPtr);
  const b = BigInt.asUintN(64, ex.hashwx_exec_final(cCtx));
  console.log(`  ${block}   | ${String(a).padStart(20)} | ${String(b).padStart(24)} | ${a === b}`);
}
console.log("\n-- same, but recompiling inner after every make --");
console.log("block | interpreted | compiled(recompiled) | match");
for (let block = 0; block < 4; block++) {
  setSeed(iCtx, iSeed, block);
  const a = BigInt.asUintN(64, ex.hashwx_exec(iCtx, 777n));
  setSeed(cCtx, cSeed, block);
  const inner = loadInner();
  ex.hashwx_exec_begin(cCtx, 777n);
  inner(regPtr, memPtr);
  const b = BigInt.asUintN(64, ex.hashwx_exec_final(cCtx));
  console.log(`  ${block}   | ${String(a).padStart(20)} | ${String(b).padStart(24)} | ${a === b}`);
}
