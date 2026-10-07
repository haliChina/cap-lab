# 求解速度：实测与优化记录

所有数字来自本机实测（ARM64 容器、Node 22、`os.availableParallelism()` = 8、内嵌 wasm）。
对照组是 Cap 自己的默认预设：`hashwx 1M + instrumentation + blockAutomatedBrowsers`，
一个 token = 4 个 hashwx 挑战，每个期望命中 250,000 次，共约 100 万次哈希。

## 总览

| | 每 token | 每分钟 | 每小时 | hashes/token |
|---|---|---|---|---|
| 基线（一挑战一 worker，解释内核） | 15.5-17.8 s | 3.37 | 202 | ~1.0 M |
| **共享队列 + 编译内核** | **2.13 s** | **28.2** | **1,692** | ~210 K |
| 最低难度（hashwx 50k，基线路径） | 0.60 s | 50.2 | 3,011 | ~100 K |

## 有效的优化：Cap 自己的编译内核（5.63x）

`core/vendor/hashwx.wasm` 除了最初使用的 `hashwx_exec`，还导出一整套"编译模式"接口。
官方 widget 走的就是这条：

```js
const ctx = hashwx_alloc(1);   // 1 = 编译模式，0 = 解释模式，两个 ctx 不能混用
const inner = new WebAssembly.Instance(
  new WebAssembly.Module(
    new Uint8Array(memory.buffer, hashwx_module(ctx), hashwx_module_size(ctx)).slice()
  ),
  { env: { memory } }
).exports.exec;

// 每 nonce：
hashwx_exec_begin(ctx, nonce);
inner(regPtr, memPtr);
const h = BigInt.asUintN(64, hashwx_exec_final(ctx));
```

单线程对比（`tools/bench-honest.mjs`，每个命中都用解释路径复核）：

```
compiled (recompile/block)    173951 hashes/s   4 real hits, 0 bogus
interpreted                   30899 hashes/s
ratio 5.63x
```

### 最大的坑：内嵌模块是按 seed 特化的

那段 11,316 字节的内嵌 wasm **把 seed 烘焙进了生成的代码**。复用一个 inner 去扫不同的
block，会在 block 0 之后**全部算错**，而且会"提前命中"假解——第一版因此测出一个假的 6.59x。

正确做法是**每次 `hashwx_make` 之后重新编译**（每 65536 nonce 一次，开销约 2.5%）。
验证脚本见 `tools/probe-seed.mjs`：

```
block | interpreted | compiled(reuse inner) | match
  0   | 10930258437565665395 | 10930258437565665395 | true
  1   |  7427553923713259602 | 14919987409754246687 | false
  1   |  7427553923713259602 |  7427553923713259602 | true   (recompiled)
```

### 三个必须同时满足的前提

1. `hashwx_alloc(0)` 与 `hashwx_alloc(1)` 是**两个独立 ctx**，混用会得到 0 或垃圾值
2. 内嵌模块**惰性生成**：`make` 之前调用 `hashwx_module()` 拿到的不是 wasm magic
3. worker 找到解后**不能退出**，要继续领其它挑战的块——否则 8 个 worker 只覆盖 2/4 个挑战

### 调度：共享队列

挑战的 nonce 空间无界，所以不必"一挑战一 worker"。用 `SharedArrayBuffer` 里的块游标让所有
worker 领同一个挑战的不同块，谁先撞上谁赢。结果：每 token 只用 21 万次哈希而不是 100 万，
因为四个挑战里最容易被撞上的那个很快就结束了，剩下的时间用来啃最难的那个。

## 试过但**无效**的四种改法

| 改法 | 预期 | 实测 | 结论 |
|---|---|---|---|
| `hashwx_make` 提到块外（每 65536 nonce 一次） | 省 65535 次调用 | 40,689 vs 44,734 hashes/s，**慢 10%** | 否定（make 几乎免费） |
| 共享队列调度（解释内核下） | 用满所有核 | 19.0 vs 15.5 s/token，**慢 20%** | 否定（编译内核下才转为正收益） |
| 常驻 worker 池（复用 wasm 实例） | 省掉每 token 的 wasm 编译 | 无可测差异 | 中性 |
| i64 参数改传 Number 减少 BigInt 分配 | 降分配压力 | `Cannot convert 0 to a BigInt` | 引擎不允许 |

微基准见 `tools/bench-inner.mjs`：

```
a) core.hashwxHash (make/nonce)          44734 hashes/s
b) make/block + asUintN                  40689 hashes/s
c) make/block + signed + Number          TypeError (Node 不允许)
```

## 为什么这台机器上并行收益有限

单线程 174k hashes/s、整机聚合 58-62k（未优化时）——8 核只跑出 1.3-1.5 倍。
`nproc` 报 8，但 cgroup 限额文件在 PRoot 里读不到，并行扩展比直接暴露了配额限制。

## 还能往哪走

| 方向 | 预期 | 说明 |
|---|---|---|
| 分布式 | 线性 | nonce 空间无界，worker *i* 领块号 ≡ *i* (mod N)，**无需协调器**；多机只是把 N 换掉 |
| sha256-pow 预设 | 9-15x（已实测） | Node 的 OpenSSL 走 SHA-NI / ARM 加密扩展，实测 278k-470k hashes/s |
| 自己写 SIMD 内核 | 4-8x / 核 | AVX2 多缓冲（8 lane）或 NEON（4 lane）；**主要工作量是逆向那段生成代码里的算法** |
| GPU | 不划算 | 小哈希串负载，8-16 核 CPU 足够，且本机无 GPU |
| 换硬件 | 一个数量级 | x86 + SHA-NI 单核约 1-2 GB/s |

## 一句话

服务端真正花的不是"你的算力差"，而是**它自己选的难度旋钮**。客户端能拿到的优化空间大约 10 倍，
这个系数会同时削弱"提高难度"这根杠杆的定价能力。
