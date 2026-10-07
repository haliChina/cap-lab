// Preset matrix: create a site key per preset, then hammer it headlessly.
//
//   node matrix.mjs <phase> [baseUrl]
//   phase: A (hashwx ladder) | B (sha256-pow ladder) | C (rsw + instrumentation + ratelimit)
//
// Each preset gets a FRESH key, so presets can't leak config into each other.

import { writeFileSync, appendFileSync } from "node:fs";
import { adminAuth, api, getToken } from "./cap-lib.mjs";

const phase = process.argv[2] || "A";
const base = process.argv[3] || "http://127.0.0.1:3010";
const ADMIN = process.env.ADMIN_KEY || "change-me-local-lab-key";

const PRESETS = {
  A: [
    { id: "hashwx-50k", protocol: "hashwx", hashwxDifficulty: 50_000, rounds: 3, budgetMs: 30_000 },
    { id: "hashwx-250k", protocol: "hashwx", hashwxDifficulty: 250_000, rounds: 3, budgetMs: 45_000 },
    { id: "hashwx-1M", protocol: "hashwx", hashwxDifficulty: 1_000_000, rounds: 2, budgetMs: 90_000 },
    { id: "hashwx-2M", protocol: "hashwx", hashwxDifficulty: 2_000_000, rounds: 1, budgetMs: 120_000 },
    { id: "hashwx-5M", protocol: "hashwx", hashwxDifficulty: 5_000_000, rounds: 1, budgetMs: 120_000 },
  ],
  B: [
    { id: "sha256-c80-d1", protocol: "sha256-pow", difficulty: 1, challengeCount: 80, rounds: 3 },
    { id: "sha256-c300-d2", protocol: "sha256-pow", difficulty: 2, challengeCount: 300, rounds: 3 },
    { id: "sha256-c1-d4", protocol: "sha256-pow", difficulty: 4, challengeCount: 1, rounds: 3 },
    { id: "sha256-c80-d4", protocol: "sha256-pow", difficulty: 4, challengeCount: 80, rounds: 2, budgetMs: 120_000 },
    { id: "sha256-c20-d5", protocol: "sha256-pow", difficulty: 5, challengeCount: 20, rounds: 1, budgetMs: 150_000 },
    { id: "sha256-c2-d6", protocol: "sha256-pow", difficulty: 6, challengeCount: 2, rounds: 1, budgetMs: 150_000 },
  ],
  C: [
    { id: "rsw-t10k", protocol: "rsw", rsw: true, rswT: 10_000, rounds: 3 },
    { id: "rsw-t75k", protocol: "rsw", rsw: true, rswT: 75_000, rounds: 2 },
    { id: "rsw-t300k", protocol: "rsw", rsw: true, rswT: 300_000, rounds: 1 },
    { id: "instr-on", protocol: "hashwx", hashwxDifficulty: 50_000, instrumentation: true, rounds: 2 },
    {
      id: "instr-block-browser",
      protocol: "hashwx",
      hashwxDifficulty: 50_000,
      instrumentation: true,
      blockAutomatedBrowsers: true,
      rounds: 2,
    },
    {
      id: "ratelimit-5-per-10s",
      protocol: "hashwx",
      hashwxDifficulty: 50_000,
      ratelimitMax: 5,
      ratelimitDuration: 10_000,
      rounds: 12,
    },
    {
      id: "ratelimit-200-per-5s",
      protocol: "hashwx",
      hashwxDifficulty: 50_000,
      ratelimitMax: 200,
      ratelimitDuration: 5_000,
      rounds: 10,
    },
  ],
};

const presets = PRESETS[phase];
if (!presets) {
  console.error(`unknown phase ${phase}`);
  process.exit(1);
}

const auth = await adminAuth(base, ADMIN);
const call = api(base, auth);
const outFile = new URL(`./matrix-${phase}.json`, import.meta.url).pathname;
writeFileSync(outFile, "[]");

const rows = [];
for (const p of presets) {
  const created = await call("POST", "/server/keys", { name: p.id });
  if (created.status !== 200) {
    console.log(`${p.id}: key create failed ${created.status}`);
    continue;
  }
  const { siteKey, secretKey } = created.data;

  // difficulty / challengeCount / ratelimit are only settable through the config route
  const patch = await call("PUT", `/server/keys/${siteKey}/config`, {
    protocol: p.protocol,
    hashwxDifficulty: p.hashwxDifficulty,
    difficulty: p.difficulty,
    challengeCount: p.challengeCount,
    rsw: p.rsw,
    rswT: p.rswT,
    instrumentation: p.instrumentation,
    blockAutomatedBrowsers: p.blockAutomatedBrowsers,
    ratelimitMax: p.ratelimitMax,
    ratelimitDuration: p.ratelimitDuration,
  });
  if (patch.status !== 200) {
    console.log(`${p.id}: config failed ${patch.status} ${JSON.stringify(patch.data)}`);
    continue;
  }

  const attempts = [];
  for (let i = 0; i < (p.rounds || 2); i++) {
    const r = await getToken(base, siteKey, { secretKey, budgetMs: p.budgetMs ?? 60_000 });
    attempts.push({
      ok: r.ok,
      status: r.status,
      stage: r.stage,
      ms: r.ms ?? null,
      solveMs: r.solveMs ?? null,
      hashes: r.work?.hashes ?? [],
      protos: r.protos ?? null,
      error: r.ok ? null : JSON.stringify(r.data ?? r.stage).slice(0, 120),
      siteverify: r.siteverify ?? null,
    });
    const a = attempts.at(-1);
    process.stdout.write(
      `  ${p.id} #${i + 1}: ${a.ok ? "PASS" : "FAIL " + (a.error || a.stage)} ` +
        `${a.ms ?? "-"}ms hashes=${(a.hashes || []).reduce((x, y) => x + (y || 0), 0)}\n`,
    );
    if (!a.ok && (a.status === 429 || a.status === 403)) break; // limit reached / blocked
  }

  const okCount = attempts.filter((a) => a.ok).length;
  const times = attempts.filter((a) => a.ok).map((a) => a.ms);
  const hashes = attempts.flatMap((a) => a.hashes || []);
  rows.push({
    preset: p.id,
    siteKey,
    secretKey,
    config: p,
    attempts,
    pass: `${okCount}/${attempts.length}`,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    totalHashes: hashes.reduce((a, b) => a + (b || 0), 0),
    hashRate: (() => {
      const ms = attempts.reduce((a, b) => a + (b.solveMs || 0), 0);
      const total = hashes.reduce((a, b) => a + (b || 0), 0);
      return ms ? Math.round((total / ms) * 1000) : null;
    })(),
    lastError: attempts.find((a) => !a.ok)?.error ?? null,
  });
  appendFileSync(outFile, JSON.stringify(rows.at(-1)) + "\n");
}

console.log(`\n| preset | pass | avg ms | hashes | rate/s | note |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of rows) {
  console.log(
    `| ${r.preset} | ${r.pass} | ${r.avgMs ?? "-"} | ${r.totalHashes || "-"} | ${r.hashRate ?? "-"} | ${(r.lastError || "").slice(0, 80)} |`,
  );
}