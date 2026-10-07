// What does the hashwx wasm actually export? The widget worker calls
// n_exec_begin / n_module / n_registers / n_exec_final and then runs a
// runtime-compiled inner module — that looks like a bulk path we are not using.
import { readFileSync } from "node:fs";

const VENDOR = process.env.HASHWX_WASM || "../cap/core/vendor/hashwx.wasm";
const bytes = readFileSync(VENDOR);
console.log("hashwx.wasm size:", bytes.length, "bytes");

const mod = await WebAssembly.compile(bytes);
console.log("\nimports:");
for (const i of WebAssembly.Module.imports(mod)) console.log(`  ${i.module}.${i.name} : ${i.kind}`);

const exports = WebAssembly.Module.exports(mod);
console.log("\nexports:");
for (const e of exports) console.log(`  ${e.name} : ${e.kind}`);

const names = exports.map((e) => e.name);
console.log("\nbulk-interface check:");
for (const h of [
  "n_exec_begin", "n_exec_final", "n_module", "n_module_size",
  "n_registers", "n_memory", "n_alloc", "n_seed",
  "hashwx_exec", "hashwx_make", "hashwx_alloc", "hashwx_seed",
]) {
  console.log(`  ${names.includes(h) ? "PRESENT" : "absent "}  ${h}`);
}