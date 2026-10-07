// Probe a Cap endpoint end to end, printing RAW responses.
// Only use it against an instance you own or are authorised to test.
//
//   node probe-remote.mjs <baseUrl> <apiPrefix> [siteKey]
//     baseUrl    e.g. http://127.0.0.1:3010
//     apiPrefix  e.g. /  (Cap standalone)   or  /api/cap/  (reverse-proxied)
import { format1Challenges } from "./oneclick.mjs";
import { Worker } from "node:worker_threads";

const BASE = process.argv[2];
if (!BASE) { console.error("usage: node probe-remote.mjs <baseUrl> <apiPrefix> [siteKey]"); process.exit(1); }
const API = process.argv[3] || "/";

const WORKER = `
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
const h = (s) => createHash("sha256").update(s).digest("hex");
for (let n = 0; ; n++) {
  if (h(workerData.salt + n).startsWith(workerData.target)) { parentPort.postMessage({ nonce: n, hashes: n + 1 }); process.exit(0); }
}
`;
const src = new URL(`data:text/javascript,${encodeURIComponent(WORKER)}`);
const solve = (x) =>
  new Promise((res, rej) => {
    const w = new Worker(src, { workerData: x });
    w.once("message", res);
    w.once("error", rej);
  });

console.log(`POST ${BASE}${API}challenge`);
const cr = await fetch(`${BASE}${API}challenge`, { method: "POST" });
const ctext = await cr.text();
console.log(`  -> ${cr.status} ${cr.headers.get("content-type")}`);
console.log(`  body: ${ctext.slice(0, 200)}`);

let ch;
try { ch = JSON.parse(ctext); } catch { console.log("  !! not JSON"); process.exit(1); }

const list = format1Challenges(ch.token, ch.challenge);
console.log(`  format=${ch.format ?? 1} c=${ch.challenge.c} d=${ch.challenge.d} | salt[0]=${list[0].salt.slice(0, 16)}… target[0]=${list[0].target}`);

const os = await import("node:os");
const cpus = os.availableParallelism?.() || os.cpus()?.length || 1;
const workers = Math.max(1, Math.min(cpus, list.length));
const chunks = Array.from({ length: workers }, () => []);
list.forEach((x, i) => chunks[i % workers].push([i, x]));
const t0 = Date.now();
const done = await Promise.all(
  chunks.map((ck) => Promise.all(ck.map(([, x]) => solve(x))).then((r) => ({ ck, r }))),
);
const solved = new Array(list.length);
for (const { ck, r } of done) ck.forEach(([i], k) => { solved[i] = r[k]; });
console.log(`  solved ${solved.length}/${list.length} in ${Date.now() - t0}ms`);

const rr = await fetch(`${BASE}${API}redeem`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: ch.token, solutions: solved.map((s) => s.nonce) }),
});
const rtext = await rr.text();
console.log(`\nPOST ${BASE}${API}redeem`);
console.log(`  -> ${rr.status} ${rr.headers.get("content-type")}`);
console.log(`  body: ${rtext.slice(0, 300)}`);