# Cap v3 协议笔记

读 `core/src/*.js` 得出的实现细节。所有字段名以源码为准。

## 入口与出口

```
POST /:siteKey/challenge   -> { token, format, challenges[], expires, instrumentation? }
POST /:siteKey/redeem      <- { token, solutions[], instr? }  -> { success, token, expires }
POST /:siteKey?/siteverify <- { secret, response }           -> { success }
```

redeem 成功返回的 token 形如 `siteKey:id:secret`，TTL **2 小时**；
challenge 本身 TTL **15 分钟**，且按 JWT 签名做一次性消费
（`SET NX blocklist:<jwt-sig>`，重放返回 403 `Challenge already redeemed`）。

## format 1（classic）

challenge token 是 HS256 JWT，载荷 `{ n, c, s, d, exp, iat, sk? }`。

**salt 和 target 不是服务端单独下发的**，客户端要从 token 推导：

```
tokenFnv = fnv1a(token)                       // 32 位 FNV-1a
saltSeed = fnv1aResume(tokenFnv, String(i+1)) // i 从 1 开始
target   = prngFromHash(fnv1aResume(saltSeed, "d"), d)   // xorshift32 PRNG
salt     = prngFromHash(saltSeed, s)
找 n 使 sha256(salt + n) 的十六进制前 d 位 == target
```

`d` 是十六进制**位数**（4 bit/位），`c` 是挑战个数，`s` 是 salt 长度。
总代价 ≈ `c × 16^d` 次 SHA-256。参数上界：`c ≤ 1000`、`s ≤ 256`、`d ≤ 16`。

## format 2

响应里 `challenges[]` 是明文，**标准答案**用 AES-256-GCM 加密在 JWT 的 `ev` 字段里
（`decryptGcm(payload.ev, secret, "cap:fmt2-v1")`）。三种协议：

| 协议 | 求解 | 默认难度 |
|---|---|---|
| `sha256-pow` | 同 format 1 的前缀匹配 | — |
| `hashwx` | WASM 里的哈希搜索 | `d = 1e6`，拆成 4 个挑战，每个 `d/4` |
| `rsw` | `y = x^(2^t) mod N`，反复平方 | `t = 75000` |
| `instrumentation` | 执行服务端下发的随机 JS 程序 | 见 `DETECTION.md` |

### hashwx 的关键实现细节

- payload 是 `{ c, d, n }`：`c` 32 字节 hex，`d` 难度，`n` 每块的 nonce 数（默认 65536）
- **`hashwx_exec(ctx, nonce)` 一次只算一个 nonce**；每 `n` 个换一次 seed：
  `seed = sha256(c || LE64(block))`，`block = nonce / n`
- 命中条件：`hash <= (2^64 - 1) / d`
- 一个容易踩的坑：按块跳着采样会白跑（我按 `block` 步进采了 100 万次样没中，
  因为每次只采到该块的第一个 nonce，命中率只有 `1/d`）
- wasm 的 i64 返回值在 JS 里是**有符号** BigInt，必须 `BigInt.asUintN(64, ...)` 再比较

### 验证顺序（`validateChallengeV2`）

1. 校验 JWT 签名 / scope / exp
2. 解密 `ev`，逐项核对 `solutions[i]`（数量必须相等）
3. 一次性消费 nonce
4. 签发 token

## 解法侧的两个非显然要求

1. format 2 的 instrumentation 结果要放在 **`solutions[]` 对应的条目里**
   （`{ instr: {...} }`），不是请求体顶层；顶层那个只对 format 1 生效。
2. 并行分片求解时**必须按原始下标回填**。round-robin 分片后直接 `flat()`
   会打乱顺序，导致解与挑战错位。
