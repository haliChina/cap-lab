# 仓库范围：包含什么、仍然排除什么

## 包含

| 类别 | 文件 |
|---|---|
| 研究笔记 | `docs/SETUP.md`、`docs/PROTOCOL.md`、`docs/MATRIX.md`、`docs/DETECTION.md` |
| 靶场与矩阵 | `tools/lab-up.sh`、`tools/lab-down.sh`、`tools/mkkey.py`、`tools/matrix.mjs`、`tools/bench.mjs`、`tools/cap-lib.mjs` |
| 探针对比 | `tools/detect-matrix.mjs`（直接调用 Cap 自己的 `detectAutomation()`，输入为手写向量） |
| **完整链路** | `tools/bypass.sh`、`tools/oneclick.mjs`、`tools/mini-browser.mjs`、`tools/instr-shim.mjs` |
| **端点探测** | `tools/probe-remote.mjs`、`tools/capcheck.sh`、`tools/capcheck.py` |

「完整链路」是能在**你指定的**实例上把 PoW、instrumentation、redeem、siteverify 一次跑完的脚本；
「端点探测」是判断某个 Cap 部署处在哪一代、开了哪些防护的小工具。
两者都是**通用**的：仓库里不预置任何具体目标地址，命令行参数必须由你提供。

## 仍然排除

| 内容 | 理由 |
|---|---|
| Cap 源码克隆（`cap/`） | 属于上游仓库；请自行 `git clone https://github.com/tiagozip/cap` 到 `cap/` 下，脚本默认从那里读取被测项目的核心模块作为对照基准 |
| 任何第三方站点的地址 | 仓库不写入、不预置任何真实目标域名；所有端点都必须由使用者在命令行显式给出 |
| 十余个一次性调试脚本 | `ab2.mjs` / `cmp.mjs` / `oracle*.mjs` / `*-probe.mjs` 等排查过程记录，无长期价值 |
| `node_modules/`、矩阵输出的 JSON | 可复现产物，不入库（见 `.gitignore`） |

## 关于 `tools/` 里那些「完整链路」脚本

它们能对**任何** Cap 部署完成整条验证流程，包括默认配置下启用的 instrumentation 与
`blockAutomatedBrowsers`。这不是疏忽，是有意的：**既然分析已经公开，写法与工具就没必要藏**，
区别只在于使用者是否对自己的目标负责。请务必只对自己拥有或已获书面授权的实例使用。

如果你只想看结论、不想跑任何东西，`docs/` 下四篇文档是自足的；
`docs/DETECTION.md` 里只写了「这一层检什么、为什么挡不住什么」，没有写「怎么逐项通过」。