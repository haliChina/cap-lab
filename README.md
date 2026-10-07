# Cap v3 本地靶场笔记（脱敏版）

对 [Cap](https://github.com/tiagozip/cap)（Apache-2.0 开源的 PoW 型 CAPTCHA 替代品）做的一轮
本地自托管实测记录。全部实验都在**自己机器上跑的 Cap 实例**上完成。

<i>Authorized security research only. 仅供合法安全研究。</i>

> 本仓库包含研究笔记、本地靶场，以及一套能对**你指定的**Cap 部署跑完整条验证链路的脚本
> （PoW → instrumentation → redeem → siteverify）。**仓库内不预置任何具体目标地址**，
> 所有端点都必须由你在命令行显式提供。与 Cap 官方无隶属关系；
> 若你是 Cap 的维护者并想讨论这里的发现，欢迎直接联系。内容范围见 `EXCLUDED.md`。

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

本仓库的所有实验均在**作者自己拥有、自己部署**的 Cap 实例上完成。文档中记录的协议细节与实测数据
仅用于理解这类产品的实现方式与防护边界。

`tools/` 中的脚本会向你**提供的**端点发起请求并提交计算结果。
**只对你自己拥有、或已获得明确书面授权的实例使用。** 未经授权对他人系统进行测试或验证，
可能违反《网络安全法》、计算机欺诈与滥用法（CFAA）等适用法律，行为责任在行为人。

### 若你是受影响方

若你认为自己因本仓库的内容受到影响，请通过该仓库的 GitHub Security Advisory 或直接联系作者，
我们会在确认后第一时间处理。

## 许可 / License

本仓库以 **Apache License 2.0** 发布（见 `LICENSE`、`NOTICE`）。未包含 Cap 的任何源代码；
`tools/` 中的脚本会从你本地克隆的 Cap 仓库读取其核心模块，作为对照基准。

## 这里有什么

| 文件 | 内容 |
|---|---|
| `docs/SETUP.md` | 把 Cap standalone 跑起来的实操记录，含若干环境坑 |
| `docs/PROTOCOL.md` | Cap v3 的 challenge / redeem 协议笔记（format 1 / format 2） |
| `docs/MATRIX.md` | 三协议 × 多难度 × 限流的预设矩阵实测与成本模型 |
| `docs/DETECTION.md` | `instrumentation` 与 `blockAutomatedBrowsers` 这一层的机制分析 |
| `tools/lab-up.sh` `lab-down.sh` `mkkey.py` | 起停靶场服务、建测试用站点密钥 |
| `tools/oneclick.mjs` `bypass.sh` | 一条命令跑完 PoW + instrumentation + redeem + siteverify |
| `tools/mini-browser.mjs` `instr-shim.mjs` | 执行服务端 instrumentation 程序所需的最小浏览器环境 |
| `tools/probe-remote.mjs` `capcheck.sh` `capcheck.py` | 端点探测：判断部署处在哪一代、开了哪些防护 |
| `tools/matrix.mjs` `bench.mjs` `cap-lib.mjs` | 预设矩阵与求解库 |
| `tools/detect-matrix.mjs` | 用 Cap 自己的 `detectAutomation()` 对比四类探针向量 |
| `EXCLUDED.md` | 仓库范围：包含什么、仍然排除什么 |

## 三条主要结论

1. **PoW 型验证码是成本计量器，不是访问控制。** salt / target 全部可由签名 token 或明文
   challenges 推导，不含浏览器信任成分。三种协议、难度从 3.5 千次哈希到 500 万次哈希，
   都能在没有浏览器的情况下解完并拿到有效 token。
2. **难度只是一个运营方自选的旋钮。** `hashwxDifficulty` 下限 50k；classic 协议的
   `difficulty` 低到 1（1 bit / 挑战）时，一个 token 只需约 3.5k 次哈希。
3. **`instrumentation` + `blockAutomatedBrowsers` 检测的是客户端自报的数据，不是运行环境。**
   探针向量由客户端脚本组装后 POST，服务端只做形状判断；而 4 个变量的标准答案是服务端用
   `domSumMock()` 预先算好的，并没有真的观察 DOM。详见 `docs/DETECTION.md`。

## 复现

```bash
# 1) 起一个自己的 Cap 实例（把上游仓库克隆到本仓库的 cap/ 下）
git clone https://github.com/tiagozip/cap
cd cap/standalone
npm install                       # 见 docs/SETUP.md：bun 的 isolated install 在部分环境下是坏的
ADMIN_KEY=change-me-local-lab-key REDIS_URL=redis://127.0.0.1:6379 \
  SERVER_PORT=3010 SERVER_HOSTNAME=0.0.0.0 ENABLE_ASSETS_SERVER=true \
  bun run ./src/index.js

# 2) 建一把最严格的测试密钥并跑矩阵
export ADMIN_KEY=change-me-local-lab-key
python3 tools/mkkey.py '{"name":"t","protocol":"hashwx","hashwxDifficulty":50000}'
node tools/matrix.mjs A          # 预设矩阵，细节见 tools/matrix.mjs 顶部的 PRESETS
```

工具脚本默认指向 `http://127.0.0.1:3010`，并从 `../cap/standalone/node_modules/capjs-core/`
读取被测项目的核心模块（即上面克隆下来的那份，用它自己的校验函数而不是我自己复刻的，
这样结论才有对照）。可用环境变量覆盖：

| 变量 | 默认值 |
|---|---|
| `ADMIN_KEY` | `change-me-local-lab-key` |
| `CAP_CORE` | `../cap/standalone/node_modules/capjs-core/src/hashwx.js` |
| `CAP_DIR` | `../cap/standalone`（`lab-up.sh` 用） |
