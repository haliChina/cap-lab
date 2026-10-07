# 仓库范围：包含什么、仍然排除什么

## 包含

| 类别 | 位置 |
|---|---|
| 研究文档 | `docs/SETUP.md`、`docs/PROTOCOL.md`、`docs/MATRIX.md`、`docs/SPEED.md`、`docs/DETECTION.md` |
| 靶场与矩阵 | `tools/lab-up.sh`、`lab-down.sh`、`mkkey.py`、`matrix.mjs`、`throughput.mjs` |
| 求解器 | `tools/solve-fast.mjs`（共享队列 + 编译内核）、`tools/cap-lib.mjs`（三协议通用） |
| 完整链路 | `tools/bypass.sh`、`tools/oneclick.mjs`、`tools/mini-browser.mjs`、`tools/instr-shim.mjs` |
| 基准与探针 | `tools/bench-inner.mjs`、`bench-bulk.mjs`、`bench-honest.mjs`、`probe-exports.mjs`、`probe-seed.mjs`、`probe-inner.mjs`、`detect-matrix.mjs` |
| 端点探测 | `tools/probe-remote.mjs`、`tools/capcheck.sh`、`tools/capcheck.py` |
| 反馈系统 | `tools/feedback/`（单按钮 + JSONL 记录） |

「完整链路」能在**你指定的**实例上把 PoW、instrumentation、redeem、siteverify 一次跑完；
「端点探测」用于判断某个 Cap 部署处在哪一代、开了哪些防护。两者都是**通用**的：
仓库不预置任何具体目标地址，命令行参数必须由你提供。

## 仍然排除

| 内容 | 理由 |
|---|---|
| Cap 源码克隆（`cap/`） | 属于上游仓库。请自行 `git clone https://github.com/tiagozip/cap` 到 `cap/` 下，脚本默认从那里读取被测项目的核心模块作为对照基准 |
| 任何第三方站点的地址 | 仓库不写入、不预置任何真实目标域名 |
| 运行时数据 | `matrix-*.json`、`feedback/results.jsonl`、`feedback/target.json` 等可复现产物与含密钥的运行态文件不入库（见 `.gitignore`） |
| 一次性调试脚本 | 排查过程中的临时脚本（`ab2.mjs` / `cmp.mjs` / `oracle*.mjs` 等）无长期价值 |

## 关于 `tools/` 里那些完整链路脚本

它们能对**任何** Cap 部署完成整条验证流程，包括默认开启的 instrumentation 与
`blockAutomatedBrowsers`。这不是疏忽，是有意的：**既然分析已经公开，写法与工具就没必要藏**，
区别只在于使用者是否对自己的目标负责。请务必只对自己拥有或已获书面授权的实例使用。

如果你只想看结论、不想跑任何东西，`docs/` 下五篇文档是自足的；
`docs/DETECTION.md` 只写「这一层检什么、为什么挡不住什么」，没有写「怎么逐项通过」。