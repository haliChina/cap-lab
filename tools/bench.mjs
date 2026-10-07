import { getToken } from "./cap-lib.mjs";

const [base, key, secret, n = "3"] = process.argv.slice(2);
for (let i = 1; i <= Number(n); i++) {
  const r = await getToken(base, key, { secretKey: secret });
  const h = r.work?.hashes || [];
  const total = h.reduce((a, b) => a + (b || 0), 0);
  const hps = total && r.work.ms ? Math.round(total / Math.max(...r.work.ms) * 1000) : 0;
  console.log(
    `#${i} ok=${r.ok} solve=${r.solveMs}ms total=${r.ms}ms hashes=[${h.join(",")}] ` +
      `agg=${hps}/s/slowest-thread sv=${JSON.stringify(r.siteverify)}`,
  );
  if (!r.ok) console.log("   ", JSON.stringify(r.data || r.stage).slice(0, 200));
}