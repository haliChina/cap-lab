# Cap Lab

对 [Cap](https://github.com/tiagozip/cap)（Apache-2.0 开源的 PoW 型 CAPTCHA 替代品）做的一轮
本地自托管实测：**协议拆解 + 预设矩阵 + 求解器优化 + 检测层分析**，附一整套可复现的靶场脚本。

<i>Authorized security research only. 仅供合法安全研究。</i>

> 本仓库包含研究文档与可运行工具，其中包括能在**你指定的**实例上跑完
> PoW + instrumentation + redeem + siteverify 全链路的脚本。
> **仓库内不预置任何具体目标地址**，所有端点都必须由你在命令行显式提供。
> 与 Cap 官方无隶属关系；若你是 Cap 的维护者并想讨论这里的发现，欢迎直接联系。

## ⚠️ 免责声明 / Disclaimer

> 本仓库仅供**合法的安全研究和教育目的**使用。本质上为交流学习所用，
> 未收集过任何第三方用户信息，也未允许他人使用本仓库内容对未授权系统进行测试。

## 法律声明 / Legal

> 使用本仓库即表示您同意以下条款。

### 免责声明的效力边界（请务必理解）

免责声明**不构成法律保护**。《网络安全法》第 27 条、《刑法》第 285/286 条、美国 CFAA 等均采用
**行为主义**定罪 —— 认定的是是否发生了**未经授权的访问行为**，而不是工具作者是否写了免责声明。
**行为责任在行为人**，作者不对任何使用方式负责。

### 仅限授权使用

本仓库的所有实验均在**作者自己拥有、自己部署**的 Cap 实例上完成。`tools/` 中的脚本会向
**你提供的**端点发起请求并提交计算结果。**只对你自己拥有、或已获得明确书面授权的实例使用。**
未经授权对他人系统进行测试或验证，可能违反《网络安全法》、计算机欺诈与滥用法（CFAA）等适用法律。

### 若你是受影响方

若你认为自己因本仓库的内容受到影响，请通过该仓库的 GitHub Security Advisory 或直接联系作者。

## 三条主要结论

1. **PoW 型验证码是成本计量器，不是访问控制。** salt / target 全部可由签名 token 或明文
   challenges 推导，不含浏览器信任成分。难度从 3.5 千次哈希到 511 万次哈希，都能无浏览器解完。
2. **难度只是运营方自选的旋钮。** `hashwxDifficulty` 下限 50k；classic 协议的 `difficulty`
   低到 1 时，一个 token 只需约 3.5k 次哈希。而**客户端侧能拿到的优化空间约 10 倍**——
   这会同时削弱"提高难度"这根杠杆的定价能力。
3. **`instrumentation` + `blockAutomatedBrowsers` 检测的是客户端自报的数据，不是运行环境。**
   探针向量由客户端组装后 POST；而 4 个变量的标准答案是服务端用 `domSumMock()` 预先算好的。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/SETUP.md` | 把 Cap standalone 跑起来的实操记录，含若干环境坑 |
| `docs/PROTOCOL.md` | challenge / redeem 协议笔记（format 1 / format 2、hashwx 实现细节） |
| `docs/MATRIX.md` | 三协议 × 多难度 × 限流的预设矩阵实测与成本模型 |
| `docs/SPEED.md` | 求解速度优化：Cap 自己的编译内核、共享队列、四种失败的尝试 |
| `docs/DETECTION.md` | instrumentation 与浏览器检测这一层的机制分析 |
| `SCOPE.md` | 仓库范围：包含什么、仍然排除什么 |

## 工具

| 文件 | 用途 |
|---|---|
| `tools/bypass.sh` | 一键：起服务 → 建最严格密钥 → 整条链路 → siteverify |
| `tools/oneclick.mjs` | 完整链路的 CLI / 库 |
| `tools/solve-fast.mjs` | 求解器：共享队列 + 编译内核（默认路径，`docs/SPEED.md`） |
| `tools/cap-lib.mjs` | 协议求解库（三协议 + 线程池 + 预算控制） |
| `tools/mini-browser.mjs` / `instr-shim.mjs` | `node:vm` 里的最小浏览器，执行服务端下发的 instrumentation 程序 |
| `tools/matrix.mjs` / `throughput.mjs` | 预设矩阵、吞吐压测 |
| `tools/bench-inner.mjs` / `bench-honest.mjs` / `bench-bulk.mjs` | 内层循环与编译/解释模式的微基准 |
| `tools/probe-*.mjs` | wasm 导出探测、内嵌模块 seed 特化验证 |
| `tools/probe-remote.mjs` / `capcheck.*` | 端点探测：部署代数与防护开关 |
| `tools/feedback/` | 一个按钮的反馈系统，结果落盘 JSONL |
| `tools/lab-up.sh` / `lab-down.sh` / `mkkey.py` | 靶场起停、建测试密钥 |

## 快速开始

```bash
# 1) 起一个自己的 Cap 实例（克隆到本仓库的 cap/ 下）
git clone https://github.com/tiagozip/cap
cd cap/standalone && npm install          # 见 docs/SETUP.md：bun 的 isolated install 在部分环境是坏的
ADMIN_KEY=<你的密钥> REDIS_URL=redis://127.0.0.1:6379 \
  SERVER_PORT=3010 SERVER_HOSTNAME=0.0.0.0 ENABLE_ASSETS_SERVER=true bun run ./src/index.js

# 2) 一条命令跑完
cd ../.. && export ADMIN_KEY=<你的密钥>
sh tools/bypass.sh strict                 # PoW + instrumentation + redeem + siteverify
node tools/matrix.mjs A                   # 预设矩阵
node tools/throughput.mjs '{"protocol":"hashwx"}' 10 1   # 吞吐压测
node tools/feedback/server.mjs            # 一个按钮的反馈系统
```

配置项：`ADMIN_KEY`、`CAP_BASE`、`CAP_CORE`、`SOLVER`（默认 `shared`，`pool` 为旧路径）。

## 实测数字

| 项 | 数字 |
|---|---|
| 默认预设整链路 | **2.13 s/token，28.2 token/分，1,692/时**（10/10 siteverify true） |
| 编译内核 vs 解释内核（单线程） | 173,951 vs 30,899 hashes/s（**5.63x**） |
| 优化前基线 | 15.5–17.8 s/token（3.37/分，202/时） |
| PoW 最低难度（hashwx 50k） | 0.60 s/token |
| anti-bot 层（instrumentation + 探针）耗时 | 毫秒级 |

## 许可 / License

本仓库以 **Apache License 2.0** 发布（见 `LICENSE`、`NOTICE`）。未包含 Cap 的任何源代码；
`tools/` 中的脚本会从你本地克隆的 Cap 仓库读取其核心模块，作为对照基准。
