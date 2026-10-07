# 预设矩阵：多协议 × 多难度下的实测

环境：ARM64 容器，Node 22，`os.availableParallelism()` = 8，每个 challenge 一个 worker。
全部在本地自托管实例上跑，challenge → 解 → redeem → siteverify 全链路。

## Phase A — hashwx（format 2，默认协议）

每个 token = 4 个 hashwx 挑战，每个期望命中 `hashwxDifficulty / 4` 次。

| 难度 | 结果 | 平均耗时 | 平均哈希数 |
|---|---|---|---|
| 50k | 3/3 通过 | 0.77 s | 11.7 万 |
| 250k | 3/3 通过 | 6.3 s | 70.6 万 |
| 1M（默认） | 2/2 通过 | 15.6 s | 168 万 |
| 2M | 1/1 通过 | 28.4 s | 164 万 |
| 5M（上限） | 1/1 通过 | 85.1 s | 511 万 |

吞吐稳定在 4–6 万次 wasm hash / 秒 / 线程，耗时与难度线性。

## Phase B — sha256-pow（format 1）

`difficulty` 是十六进制位数（4 bit/位），`challengeCount` 是挑战个数，代价 ≈ `c × 16^d`。

| c × d | 结果 | 平均耗时 | 平均哈希数 |
|---|---|---|---|
| 80 × 1 | 3/3 通过 | 0.30 s | 3,551 |
| 300 × 2 | 3/3 通过 | 0.72 s | 22.6 万 |
| 1 × 4 | 3/3 通过 | 0.17 s | 7.1 万 |
| 80 × 4 | 2/2 通过 | 22.0 s | 1134 万 |
| 20 × 5 | 1/1 通过 | 63.5 s | 1862 万 |
| 2 × 6 | 1/1 通过 | 60.1 s | 2828 万 |

注意第一行：**d=1 时一个 token 只需 3.5k 次哈希**，几乎免费。

## Phase C — rsw / instrumentation / 限流

| 预设 | 结果 | 备注 |
|---|---|---|
| rsw t=10k / 75k / 300k | 全部通过 | 0.23 s / 0.90 s / 3.33 s |
| `instrumentation: true` | 被拦 | PoW 已解完，卡在没提交 instrumentation 结果 |
| `instrumentation + blockAutomatedBrowsers` | 被拦 | 同上 |
| 限流 5 次/10s | 第 5 次起被拦 | `{"error":"Rate limit exceeded"}` |
| 限流 200 次/5s | 10/10 通过 | 限流一放宽就全过 |

## 成本模型

| 预设 | 单 token 代价 | 本机 4 线程 |
|---|---|---|
| hashwx 1M（默认） | 168 万次哈希 | 15.6 s |
| hashwx 5M（上限） | 511 万次哈希 | 85 s |
| sha256-pow c=80 d=4 | 1134 万次 SHA-256 | 22.0 s |
| rsw t=300k | 30 万次模平方 | 3.3 s |

放大手段都在攻击者一侧：线程/进程数、换用 sha256-pow（纯 JS 的 SHA-256 在 Node 里
约 10–47 万次/秒，比 wasm 循环快一个量级）、多机。所以「调高 PoW 难度」的边际收益不高——
算力一扩就线性抵消。

## 限流实现的两个细节

`standalone/src/ratelimit.js` 的计数桶键是 `rl:{scope}:{ip}:{duration}:{window}`：

- **按 IP + 时间窗共享，不按 site key**。同一 IP 下不同密钥共用配额，一把吵闹的 key
  会拖垮同 IP 的其它 key；换 key 也**不能**重置限流。
- 管理请求（建 key、改配置）吃同一个桶，所以一把 `max=4` 的新 key 实际只剩 2 次
  challenge 配额。
- 被拦的表现是 `challenge` 端点直接 429，不是 redeem 失败——排查时要分清是哪一层挡的。
