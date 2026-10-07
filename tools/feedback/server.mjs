// Minimal feedback service around the Cap bypass lab.
//
//   node feedback/server.mjs
//
// GET  /            single-page UI (one button)
// POST /api/run     mint one token, record the result, return the verdict
// GET  /api/logs    recent records
// GET  /api/stats   aggregate over all records
//
// Zero dependencies: node:http + fs. Records append to results.jsonl.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adminAuth, api } from "../cap-lib.mjs";
// full chain: PoW + instrumentation program + redeem + siteverify.
// cap-lib getToken is PoW-only (it submits an empty slot for instrumentation).
import { getToken } from "../oneclick.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "results.jsonl");
const TARGET = path.join(HERE, "target.json");
const PORT = Number(process.env.PORT || 3011);
const BASE = process.env.CAP_BASE || "http://127.0.0.1:3010";
const ADMIN = process.env.ADMIN_KEY;
if (!ADMIN) throw new Error("set ADMIN_KEY to your instance admin key");

// One site key for the whole service. If none is configured, create the strictest
// preset the instance offers so the button is meaningful out of the box.
let SITE_KEY = process.env.CAP_SITE_KEY || null;
let SECRET_KEY = process.env.CAP_SECRET_KEY || null;
let CONFIG = "env";

// reuse the same key across restarts; minting a fresh one per boot would litter
// the target instance with throwaway keys
if (!SITE_KEY && fs.existsSync(TARGET)) {
  try {
    const saved = JSON.parse(fs.readFileSync(TARGET, "utf8"));
    SITE_KEY = saved.siteKey; SECRET_KEY = saved.secretKey; CONFIG = saved.config;
  } catch {}
}

async function ensureKey() {
  if (SITE_KEY) return;
  const auth = await adminAuth(BASE, ADMIN);
  const call = api(BASE, auth);
  const created = await call("POST", "/server/keys", {
    name: "feedback-demo",
    protocol: "hashwx",
    hashwxDifficulty: 1_000_000,
    instrumentation: true,
    blockAutomatedBrowsers: true,
  });
  if (created.status !== 200) throw new Error(`key create failed: ${created.status}`);
  SITE_KEY = created.data.siteKey;
  SECRET_KEY = created.data.secretKey;
  CONFIG = "strict (hashwx 1M + instrumentation + blockAutomatedBrowsers)";
  fs.writeFileSync(TARGET, JSON.stringify({ siteKey: SITE_KEY, secretKey: SECRET_KEY, config: CONFIG }));
  console.log(`[feedback] created site key ${SITE_KEY}`);
}

function record(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

function recent(limit = 20) {
  if (!fs.existsSync(LOG)) return [];
  const lines = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
}

function stats() {
  const all = recent(100000);
  const ok = all.filter((r) => r.ok);
  const avg = (xs, f) => (xs.length ? Math.round(xs.reduce((a, b) => a + f(b), 0) / xs.length) : null);
  return {
    total: all.length,
    passed: ok.length,
    failed: all.length - ok.length,
    avgMs: avg(ok, (r) => r.ms),
    avgHashes: avg(ok, (r) => r.hashes),
  };
}

async function runOnce() {
  await ensureKey();
  const t0 = Date.now();
  const r = await getToken(BASE, SITE_KEY, { secretKey: SECRET_KEY });
  const hashes = (r.hashes || []).reduce((a, b) => a + (b || 0), 0);
  const entry = {
    ts: new Date().toISOString(),
    siteKey: SITE_KEY,
    config: CONFIG,
    ok: !!r.ok,
    ms: Date.now() - t0,
    hashes,
    status: r.status ?? null,
    error: r.ok ? null : JSON.stringify(r.data ?? r.stage ?? r).slice(0, 160),
    protos: r.protos ?? r.challenges ?? null,
    instrumentation: r.instrProduced ?? null,
    siteverify: r.siteverify?.success ?? null,
  };
  record(entry);
  return entry;
}

const json = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(path.join(HERE, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const entry = await runOnce();
      return json(res, 200, { ...entry, stats: stats() });
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      return json(res, 200, { records: recent(Number(url.searchParams.get("limit") || 20)) });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      return json(res, 200, stats());
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[feedback] http://0.0.0.0:${PORT}  target=${BASE}  log=${LOG}`);
});