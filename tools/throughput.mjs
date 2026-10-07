// Sustained throughput benchmark: mint N tokens per scenario, single or parallel.
//
//   node throughput.mjs '<keyConfigJson>' <tokens> <parallel> [baseUrl]
//
// Prints per-token wall time, aggregate hash rate, and tokens/hour.

import { adminAuth, api } from "./cap-lib.mjs";
import { getToken } from "./oneclick.mjs";  // full chain (PoW + instrumentation + redeem)

const [cfgJson, tokensArg, parArg, base = "http://127.0.0.1:3010"] = process.argv.slice(2);
const cfg = JSON.parse(cfgJson || "{}");
const TOKENS = Number(tokensArg || 5);
const PAR = Number(parArg || 1);
const ADMIN = process.env.ADMIN_KEY;
if (!ADMIN) throw new Error("set ADMIN_KEY to your instance admin key");

const auth = await adminAuth(base, ADMIN);
const created = await api(base, auth)("POST", "/server/keys", { name: "bench", ...cfg });
if (created.status !== 200) { console.error("key create failed", created.status); process.exit(1); }
const { siteKey, secretKey } = created.data;

const patch = {};
for (const k of ["difficulty", "challengeCount", "ratelimitMax", "ratelimitDuration", "hashwxDifficulty"]) {
  if (cfg[k] !== undefined) patch[k] = cfg[k];
}
if (Object.keys(patch).length) await api(base, auth)("PUT", `/server/keys/${siteKey}/config`, patch);

let protos = "?";
{
  const ch = await (await fetch(`${base}/${siteKey}/challenge`, { method: "POST" })).json();
  protos =
    (ch.challenges || []).map((c) => c.protocol).join("+") ||
    `sha256-pow(c=${ch.challenge?.c},d=${ch.challenge?.d})`;
}

const t0 = Date.now();
const perToken = [];

async function worker(n) {
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    const r = await getToken(base, siteKey, { secretKey });
    const hashes = (r.hashes || r.work?.hashes || []).reduce((a, b) => a + (b || 0), 0);
    perToken.push({ ms: Date.now() - t, hashes, ok: r.ok });
  }
}

const per = Math.ceil(TOKENS / PAR);
await Promise.all(Array.from({ length: PAR }, () => worker(per)));

const wall = Date.now() - t0;
const ok = perToken.filter((t) => t.ok);
const totalHashes = perToken.reduce((a, b) => a + b.hashes, 0);
const avgMs = Math.round(ok.reduce((a, b) => a + b.ms, 0) / (ok.length || 1));
const busyMs = perToken.reduce((a, b) => a + b.ms, 0);

console.log(
  JSON.stringify({
    config: { ...cfg, ...patch },
    protos,
    siteKey,
    tokens: perToken.length,
    ok: ok.length,
    parallel: PAR,
    wallMs: wall,
    avgMsPerToken: avgMs,
    tokensPerMin: +((perToken.length / wall) * 60000).toFixed(2),
    tokensPerHour: Math.round((perToken.length / wall) * 3600000),
    totalHashes,
    aggregateHashRate: busyMs ? Math.round((totalHashes / busyMs) * 1000) : 0,
  }),
);