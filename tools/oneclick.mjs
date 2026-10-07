// One-command Cap bypass for an instance you control / are authorised to test.
//
//   node oneclick.mjs --base http://127.0.0.1:3010 --site <siteKey> [--secret sk-...]
//   node oneclick.mjs --base http://127.0.0.1:3010 --admin <ADMIN_KEY> --create strict
//
// Does the whole chain: proof-of-work, the instrumentation program (executed in a
// Node mini-browser), redeem, and optionally siteverify. No browser involved.

import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { runInstrumentation } from "./mini-browser.mjs";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const BASE = arg("base", "http://127.0.0.1:3010");
const CORE =
  process.env.CAP_CORE ||
  new URL("../cap/standalone/node_modules/capjs-core/src/hashwx.js", import.meta.url).pathname;

function log(...a) { console.log(...a); }

// ---- optional: create a site key with the strictest preset ----
async function createKey(adminKey, preset) {
  const cfg = preset === "strict"
    ? { name: "oneclick-strict", protocol: "hashwx", hashwxDifficulty: 1000000, instrumentation: true, blockAutomatedBrowsers: true }
    : { name: "oneclick", protocol: "hashwx", hashwxDifficulty: 1000000 };
  const login = await (await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
  })).json();
  if (!login.success) throw new Error("admin login failed");
  const tok = "Bearer " + Buffer.from(JSON.stringify({ token: login.session_token, hash: login.hashed_token })).toString("base64");
  const key = await (await fetch(`${BASE}/server/keys`, {
    method: "POST", headers: { "content-type": "application/json", authorization: tok },
    body: JSON.stringify(cfg),
  })).json();
  if (!key.siteKey) throw new Error("key creation failed: " + JSON.stringify(key).slice(0, 120));
  return key;
}

// ---- format 1: salt/target derived from the signed token itself ----
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}
function fnv1aResume(state, str) {
  let h = state;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}
function prngFromHash(initialHash, length) {
  let state = initialHash, out = "";
  while (out.length < length) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.substring(0, length);
}
export function format1Challenges(token, { c, s, d }) {
  const f = fnv1a(token), out = [];
  for (let i = 0; i < c; i++) {
    const ss = fnv1aResume(f, String(i + 1));
    out.push({
      salt: prngFromHash(ss, s),
      target: prngFromHash(fnv1aResume(ss, "d"), d),
    });
  }
  return out;
}

// ---- proof of work ----
const WORKER = `
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
const core = await import(pathToFileURL(${JSON.stringify(CORE)}).href);
if (workerData.salt !== undefined) {
  const { createHash } = await import("node:crypto");
  const h = (s) => createHash("sha256").update(s).digest("hex");
  const t0 = Date.now();
  for (let n = 0; ; n++) {
    if (Date.now() - t0 > (workerData.budgetMs || 600000)) { parentPort.postMessage({ timeout: true }); process.exit(0); }
    if (h(workerData.salt + n).startsWith(workerData.target)) {
      parentPort.postMessage({ nonce: n, hashes: n + 1 });
      process.exit(0);
    }
  }
}
const state = await core.hashwxReady();
const { c, d, n } = workerData;
const ch = new Uint8Array(core.HASHWX_CHALLENGE_SIZE);
for (let i = 0; i < 32; i++) ch[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
const target = core.hashwxTarget(d), w = BigInt(n);
let hashes = 0;
for (let block = 0n; ; block++) {
  const seed = core.hashwxSeed(ch, block), base = block * w;
  for (let k = 0n; k < w; k++) {
    hashes++;
    if (core.hashwxHash(state, seed, base + k) <= target) { parentPort.postMessage({ nonce: (base + k).toString(), hashes }); process.exit(0); }
  }
}
`;

function solve(payload, budgetMs = 180000) {
  const src = new URL(`data:text/javascript,${encodeURIComponent(WORKER)}`);
  return new Promise((resolve, reject) => {
    const w = new Worker(src, { workerData: payload });
    const t = setTimeout(() => { w.terminate(); reject(new Error("pow timeout")); }, budgetMs);
    w.once("message", (r) => { clearTimeout(t); resolve(r); });
    w.once("error", reject);
  });
}

// ---- the whole pipeline ----
export async function getToken(base, siteKey, { secretKey, budgetMs, apiPrefix } = {}) {
  const t0 = Date.now();
  const api = apiPrefix ? `${base}${apiPrefix}` : `${base}/${siteKey}`;
  const ch = await (await fetch(`${api}/challenge`, { method: "POST" })).json();
  if (!ch.token) {
    return {
      ok: false, stage: "challenge", data: ch, hashes: [], hasInstrumentation: false,
      instrProduced: false, instrError: null, status: 0, ms: Date.now() - t0,
    };
  }

  // ---- format 1 (classic sha256-pow): everything derives from the token ----
  if (!ch.format && ch.challenge) {
    const list = format1Challenges(ch.token, ch.challenge);
    const os = await import("node:os");
    const cpus = os.availableParallelism?.() || os.cpus()?.length || 1;
    const workers = Math.max(1, Math.min(cpus, list.length));
    const chunks = Array.from({ length: workers }, () => []);
    list.forEach((x, i) => chunks[i % workers].push([i, x]));
    const done = await Promise.all(chunks.map((ck) =>
      Promise.all(ck.map(([, x]) => new Promise((res, rej) => {
        const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER)}`), { workerData: { ...x, budgetMs } });
        const t = setTimeout(() => { w.terminate(); rej(new Error("timeout")); }, budgetMs ?? 600000);
        w.once("message", (r) => { clearTimeout(t); res(r); });
        w.once("error", rej);
      }))).then((r) => ({ ck, r }))));
    const solved1 = new Array(list.length);
    for (const { ck, r } of done) ck.forEach(([i], k) => { solved1[i] = r[k]; });
    const rr1 = await fetch(`${api}/redeem`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ch.token, solutions: solved1.map((s) => s.nonce) }),
    });
    const res1 = await rr1.json().catch(() => null);
    return {
      ok: rr1.status === 200 && res1?.success === true, ms: Date.now() - t0,
      format: 1, hashes: solved1.map((s) => s.hashes),
      hasInstrumentation: false, instrProduced: false, instrError: null,
      status: rr1.status, token: res1?.token, data: res1,
      proto: `sha256-pow c=${ch.challenge.c} d=${ch.challenge.d} s=${ch.challenge.s}`,
    };
  }

  const instrEntry = ch.challenges.find((c) => c.protocol === "instrumentation");
  const pow = ch.challenges.filter((c) => c.protocol === "hashwx");

  let solved = [];
  if (pow.length) {
    const os = await import("node:os");
    const cpus = os.availableParallelism?.() || os.cpus()?.length || 1;
    const workers = Math.max(1, Math.min(cpus, pow.length));
    const chunks = Array.from({ length: workers }, () => []);
    pow.forEach((c, i) => chunks[i % workers].push([i, c]));
    // keep original indexes: a plain flat() scrambles order when workers < count
    const done = await Promise.all(chunks.map((ck) =>
      Promise.all(ck.map(([, c]) => solve(c.payload, budgetMs))).then((r) => ({ ck, r }))));
    solved = new Array(pow.length);
    for (const { ck, r } of done) ck.forEach(([i], k) => { solved[i] = r[k]; });
  }

  let instr = null, instrError = null;
  const blob = ch.instrumentation || instrEntry?.payload?.blob;
  if (blob) {
    try { instr = await runInstrumentation(blob); } catch (e) { instrError = String(e?.message || e); }
  }

  const solutions = ch.challenges.map((c, i) => {
    if (c.protocol === "hashwx") return { nonce: Number(solved[pow.findIndex((p) => p === c)].nonce) };
    if (c.protocol === "rsw") return {};
    return instr ? { instr } : {};
  });

  const rr = await fetch(`${api}/redeem`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ch.token, solutions }),
  });
  const res = await rr.json().catch(() => null);
  const out = {
    ok: rr.status === 200 && res?.success === true,
    ms: Date.now() - t0,
    hashes: solved.map((s) => s.hashes),
    hasInstrumentation: !!blob,
    instrProduced: !!instr,
    instrError,
    status: rr.status,
    token: res?.token,
    data: res,
  };
  if (out.ok && secretKey) {
    const sv = await fetch(`${api}/siteverify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: secretKey, response: res.token }),
    });
    out.siteverify = await sv.json().catch(() => null);
  }
  return out;
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  let siteKey = arg("site"), secretKey = arg("secret");
  const apiPrefix = arg("api", null);
  if (!siteKey && !apiPrefix) siteKey = "";
  if (!siteKey && arg("admin")) {
    const key = await createKey(arg("admin"), arg("create", "strict"));
    siteKey = key.siteKey; secretKey = key.secretKey;
    log(`created ${arg("create", "strict")} key: ${siteKey}`);
  }
  if (!siteKey && !apiPrefix) {
    console.error("need --site <siteKey>, --api <prefix>, or --admin <ADMIN_KEY> --create strict");
    process.exit(1);
  }

  const rounds = Number(arg("rounds", "1"));
  let pass = 0;
  const times = [];
  for (let i = 1; i <= rounds; i++) {
    // a network blip on redeem burns the challenge nonce, so retry the WHOLE cycle
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await getToken(BASE, siteKey, { secretKey, apiPrefix });
        if (r.ok || r.stage !== "challenge") break;
      } catch (e) {
        log(`#${i} network error on attempt ${attempt + 1}: ${String(e.cause?.code || e.message).slice(0, 60)}`);
      }
    }
    if (!r) { log(`#${i} gave up after 3 attempts`); continue; }
    times.push(r.ms);
    if (r.ok) pass++;
    const bits = [
      r.proto ? `pow:${r.proto}` : "",
      r.stage === "challenge" ? `challenge REJECTED: ${JSON.stringify(r.data).slice(0, 70)}`
        : r.hasInstrumentation ? `instr:${r.instrProduced ? "executed" : "MISSING"}${r.instrError ? " (" + r.instrError + ")" : ""}` : "instr:not-required",
      `pow:${r.hashes.filter(Boolean).length ? r.hashes.join("+") + " hashes" : "-"}`,
      `redeem:${r.status}${r.ok ? " OK" : " " + JSON.stringify(r.data).slice(0, 60)}`,
      r.siteverify ? `siteverify:${JSON.stringify(r.siteverify)}` : "",
    ];
    log(`#${i} ${r.ms}ms  ${bits.filter(Boolean).join("  ")}`);
  }
  const ok = times.filter((_, i) => i < pass);
  log(`\n${pass}/${rounds} tokens minted without a browser`);
  if (ok.length) {
    const avg = Math.round(ok.reduce((a, b) => a + b, 0) / ok.length);
    log(`avg ${avg}ms/token  (${(3600000 / avg).toFixed(0)} tokens/hour, single process)`);
  }
  process.exit(pass === rounds ? 0 : 1);
}