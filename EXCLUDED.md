# 有意未包含的内容

这一版刻意不含「可直接对任意 Cap 部署运行的绕过链路」。理由是研究价值在**发现本身**，
而不在一份能被别人直接拿去用的武器；把两者绑在一起发布，会让这份研究对防守方的价值下降。

## 未包含

| 文件（原靶场里） | 内容 | 不发的理由 |
|---|---|---|
| `bypass.sh` / `oneclick.mjs` | 一条命令跑完 PoW + instrumentation + redeem + siteverify | 可直接对任意部署使用 |
| `mini-browser.mjs` | 用 `node:vm` 模拟浏览器环境以执行 instrumentation 程序的实现 | 同上，是上面那条链的核心部件 |
| `instr-shim.mjs` | 同上，最早的实验脚本 | 同上 |
| `probe-remote.mjs` / `capcheck.sh` / `capcheck.py` | 指向某个具体第三方生产域名的远程探针 | 不应把第三方生产站点写进公开仓库 |
| `cap/` | Cap 源码克隆（本机 100MB+） | 属于上游仓库，不该在自己的仓库里再放一份 |
| 十余个一次性调试脚本 | `ab2.mjs` / `cmp.mjs` / `oracle*.mjs` / `*probe*.mjs` 等 | 排查过程记录，无长期价值 |

## 保留了什么、为什么

- **PoW-only 求解器**（`tools/` 里）：它实现的是 Cap 已公开发布的算法，`capjs-core`
  本身就导出了这些函数，发布它不增加任何信息量。
- **向量对比脚本**（`tools/detect-matrix.mjs`）：它是 `docs/DETECTION.md` 的证据，
  用的是 Cap 自己仓库里的 `detectAutomation()`，输入是手写向量。
- **矩阵与协议笔记**：可复现的实测数据，是这份研究的主体价值。

如果你只是想自己留着（不上公开仓库），上面那些文件原样都在本地靶场目录里。
