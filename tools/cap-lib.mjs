// Shared solver core for the Cap lab.
//
// Two things are optimised here relative to calling capjs-core directly:
//  1. hashwx: hashwx_make() is hoisted out of the inner loop (once per 65536-nonce
//     block, exactly like the official widget worker does) and the WASM return value
//     is read through a BigUint64Array view instead of BigInt boxing.
//  2. every protocol gets its own worker thread so N challenges solve in parallel.

import { createHash } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const CORE =
  process.env.CAP_CORE ||
  new URL("../cap/standalone/node_modules/capjs-core/src/hashwx.js", import.meta.url).pathname;

export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

export const hexToBytes = (hex, len) => {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function solveSha256Prefix(salt, target, budgetMs = Infinity) {
  const t0 = Date.now();
  for (let nonce = 0; ; nonce++) {
    if (sha256hex(salt + nonce).startsWith(target)) return nonce;
    if (Date.now() - t0 > budgetMs) return { timeout: true, tried: nonce };
  }
}

export function solveRsw({ N, x, t }) {
  const M = BigInt(`0x${N}`);
  let y = BigInt(`0x${x}`);
  for (let i = 0; i < t; i++) y = (y * y) % M;
  return y.toString(16);
}

/* ------------------------------- hashwx -------------------------------- */
// Direct WASM access. `state` is what capjs-core's hashwxReady() resolves to:
//   { exports, ctx, seedPtr }
// hashwx_make() hashes the 32-byte seed into the module state; hashwx_exec(nonce)
// then returns ONE 64-bit hash for that nonce.

let _state = null;
async function hashwxState() {
  if (!_state) {
    const mod = await import(pathToFileURL(CORE).href);
    _state = await mod.hashwxReady();
  }
  return _state;
}

export async function solveHashwx(payload, budgetMs = Infinity) {
  const core = await import(pathToFileURL(CORE).href);
  const state = await hashwxState();
  const { c, d, n } = payload;
  const challenge = hexToBytes(c, core.HASHWX_CHALLENGE_SIZE);
  const target = core.hashwxTarget(d);
  const w = BigInt(n);
  const t0 = Date.now();
  let hashes = 0;
  // NOTE: core.hashwxHash re-seeds + re-makes for EVERY nonce. A hoisted-make
  // variant is ~3x faster and verified correct in isolation (order-probe,
  // ctx-probe, worker-probe: 16/16), but the server rejected its output with
  // identical inputs — see README "hashwx anomaly". Correctness wins for now.
  for (let block = 0n; ; block++) {
    const seed = core.hashwxSeed(challenge, block);
    const base = block * w;
    if (process.env.CAP_FAST === "1") {
      // one make per block, exec per nonce (same shape as the official widget worker)
      const { exports, ctx, seedPtr } = state;
      new Uint8Array(exports.memory.buffer, seedPtr, 32).set(seed);
      exports.hashwx_make(ctx, seedPtr);
      const lim = BigInt.asUintN(64, target);
      for (let k = 0n; k < w; k++) {
        const nonce = BigInt.asUintN(64, base + k);
        hashes++;
        if (BigInt.asUintN(64, exports.hashwx_exec(ctx, nonce)) <= lim) {
          return { nonce: nonce.toString(), hashes, ms: Date.now() - t0 };
        }
      }
    } else {
      for (let k = 0n; k < w; k++) {
        const nonce = base + k;
        hashes++;
        if (core.hashwxHash(state, seed, nonce) <= target) {
          return { nonce: nonce.toString(), hashes, ms: Date.now() - t0 };
        }
      }
    }
    if (Date.now() - t0 > budgetMs) return { timeout: true, hashes, ms: Date.now() - t0 };
  }
}

function hashwxSeedBuf(challenge, block) {
  const buf = new Uint8Array(challenge.length + 8);
  buf.set(challenge, 0);
  let rest = BigInt(block);
  for (let i = 0; i < 8; i++) {
    buf[challenge.length + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return createHash("sha256").update(buf).digest();
}

/* ---------------------------- format 1 --------------------------------- */
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
  let state = initialHash;
  let out = "";
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.substring(0, length);
}

// token-derived salt/target, same as core/src/index.js validateChallenge()
export function format1Challenges(token, { c, s, d }) {
  const tokenFnv = fnv1a(token);
  const out = [];
  for (let i = 0; i < c; i++) {
    const saltSeed = fnv1aResume(tokenFnv, String(i + 1));
    const targetSeed = fnv1aResume(saltSeed, "d");
    out.push({ salt: prngFromHash(saltSeed, s), target: prngFromHash(targetSeed, d) });
  }
  return out;
}

/* --------------------------- worker plumbing ---------------------------- */
// One worker handles a CHUNK of challenges so a key with c=300 doesn't spawn 300 threads.
export function solveChunkInWorker(challenges, budgetMs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { challenges, budgetMs },
    });
    w.once("message", resolve);
    w.once("error", reject);
  });
}

async function solveList(challenges, budgetMs) {
  const os = await import("node:os");
  // NOTE: in this Android/PRoot sandbox os.cpus() is EMPTY, so fall back to
  // availableParallelism() and never below 1. Chunking also has to preserve the
  // original index — a plain round-robin + flat() scrambles the results whenever
  // workers < challenges.length (that bug silently sent wrong solutions).
  const cpus = os.availableParallelism?.() || os.cpus()?.length || 1;
  const workers = Math.max(1, Math.min(cpus, challenges.length));
  const chunks = Array.from({ length: workers }, () => []);
  challenges.forEach((c, i) => chunks[i % workers].push([i, c]));
  const done = await Promise.all(
    chunks.map((chunk) =>
      solveChunkInWorker(chunk.map(([, c]) => c), budgetMs).then((r) => ({ chunk, r })),
    ),
  );
  const out = new Array(challenges.length);
  for (const { chunk, r } of done) chunk.forEach(([i], k) => { out[i] = r[k]; });
  return out;
}

if (!isMainThread) {
  const { challenges, budgetMs } = workerData;
  const out = [];
  for (const challenge of challenges) {
    if (challenge.protocol === "sha256-pow") {
      const r = solveSha256Prefix(challenge.payload.salt, challenge.payload.target, budgetMs);
      out.push({ nonce: r === r.timeout ? null : r, hashes: r === r.timeout ? r.tried : r + 1, timeout: r === r.timeout });
    } else if (challenge.protocol === "rsw") {
      const t0 = Date.now();
      out.push({ y: solveRsw(challenge.payload), ms: Date.now() - t0 });
    } else if (challenge.protocol === "instrumentation") {
      // not a proof of work: needs a real browser to execute the script
      out.push({ skipped: "instrumentation" });
    } else {
      out.push(await solveHashwx(challenge.payload, budgetMs));
    }
    if (out.at(-1).timeout) break;
  }
  parentPort.postMessage(out);
  process.exit(0);
}

/* ------------------------------ http glue ------------------------------- */
export async function adminAuth(base, adminKey) {
  const r = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
  });
  const d = await r.json();
  if (!d.success) throw new Error("admin login failed");
  return "Bearer " + Buffer.from(JSON.stringify({ token: d.session_token, hash: d.hashed_token })).toString("base64");
}

export const api = (base, auth) => async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

// one full token: challenge -> solve -> redeem -> optional siteverify
export async function getToken(base, siteKey, { secretKey, budgetMs = 60000 } = {}) {
  const t0 = Date.now();
  const cr = await fetch(`${base}/${siteKey}/challenge`, { method: "POST" });
  const ch = await cr.json();
  if (!ch.token) return { ok: false, stage: "challenge", status: cr.status, data: ch };

  let solutions;
  let work = null;
  if (ch.format === 2) {
    const parts = await solveList(ch.challenges, budgetMs);
    if (parts.some((p) => p.timeout)) {
      return { ok: false, stage: "solve-timeout", work: parts, ms: Date.now() - t0, ch };
    }
    solutions = ch.challenges.map((c, i) => {
      if (parts[i]?.skipped) return {};
      return c.protocol === "rsw" ? { y: parts[i].y } : { nonce: Number(parts[i].nonce) };
    });
    work = {
      hashes: parts.map((p) => p.hashes).filter((x) => x !== undefined),
      ms: parts.map((p) => p.ms),
    };
  } else {
    const list = format1Challenges(ch.token, ch.challenge);
    const parts = await solveList(
      list.map((x) => ({ protocol: "sha256-pow", payload: x })),
      budgetMs,
    );
    if (parts.some((p) => p.timeout)) {
      return { ok: false, stage: "solve-timeout", work: parts, ms: Date.now() - t0, ch };
    }
    solutions = parts.map((p) => p.nonce);
    work = {
      hashes: parts.map((p) => p.hashes).filter((x) => x !== undefined),
      count: list.length,
      difficulty: ch.challenge.d,
      size: ch.challenge.s,
    };
  }
  const solveMs = Date.now() - t0;

  const body = {
    token: ch.token,
    solutions,
    ...(ch.instrumentation ? { instr: ch._instr } : {}),
  };
  if (process.env.CAP_DEBUG) {
    console.error("[debug solutions]", JSON.stringify(body.solutions).slice(0, 400));
    if (process.env.CAP_DEBUG === "2" && ch.format === 2) {
      const mod = await import(pathToFileURL(CORE).href);
      for (let i = 0; i < ch.challenges.length; i++) {
        const c = ch.challenges[i];
        if (c.protocol !== "hashwx") continue;
        const ok = await mod.verifyHashwxSolution({ ...c.payload }, body.solutions[i]);
        console.error(
          `[oracle] #${i} c=${c.payload.c.slice(0, 8)} d=${c.payload.d} nonce=${body.solutions[i].nonce} ok=${ok}`,
        );
      }
    }
  }
  globalThis.__lastBody = body;
  const rr = await fetch(`${base}/${siteKey}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await rr.json().catch(() => null);
  const out = {
    ok: rr.status === 200 && res?.success === true,
    stage: "redeem",
    status: rr.status,
    solveMs,
    ms: Date.now() - t0,
    data: res,
    work,
    format: ch.format ?? 1,
    protos: ch.challenges?.map((x) => x.protocol) ?? [`sha256-pow c=${ch.challenge.c} d=${ch.challenge.d}`],
  };
  if (out.ok && secretKey) {
    const sv = await fetch(`${base}/${siteKey}/siteverify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: secretKey, response: res.token }),
    });
    out.siteverify = await sv.json().catch(() => null);
  }
  return out;
}