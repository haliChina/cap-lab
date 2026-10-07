// Pinpoint where the compiled path dies: one call at a time, with logging.
import { pathToFileURL } from "node:url";

const CORE = process.env.CAP_CORE || "../cap/standalone/node_modules/capjs-core/src/hashwx.js";
const core = await import(pathToFileURL(CORE).href);
const st = await core.hashwxReady();
const ex = st.exports;

const ctx2 = ex.hashwx_alloc(1);
const seedPtr = st.seedPtr;
const chal = new Uint8Array(32).fill(7);
new Uint8Array(ex.memory.buffer, seedPtr, 32).set(core.hashwxSeed(chal, 0n));
ex.hashwx_make(ctx2, seedPtr);
console.log("make done");

const ptr = ex.hashwx_module(ctx2);
const size = ex.hashwx_module_size(ctx2);
const bytes = new Uint8Array(ex.memory.buffer, ptr, size).slice();
console.log("inner bytes:", size, "magic:", Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" "));

const mod = new WebAssembly.Module(bytes);
console.log("inner imports:", WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}:${i.kind}`).join(", ") || "(none)");
console.log("inner exports:", WebAssembly.Module.exports(mod).map((e) => `${e.name}:${e.kind}`).join(", ") || "(none)");

const inner = new WebAssembly.Instance(mod, { env: { memory: ex.memory } }).exports.exec;
console.log("inner exec:", typeof inner);

const regPtr = ex.hashwx_registers(ctx2);
const memPtr = ex.hashwx_memory(ctx2);
console.log("regPtr:", regPtr, "memPtr:", memPtr);

ex.hashwx_exec_begin(ctx2, 7n);
console.log("exec_begin ok");
try {
  inner(regPtr, memPtr);
  console.log("inner(regPtr, memPtr) ok");
} catch (e) {
  console.log("inner call threw:", e.message);
}
console.log("exec_final:", ex.hashwx_exec_final(ctx2));
console.log("interpreted hashwx_exec(ctx2, 7):", ex.hashwx_exec(ctx2, 7n));