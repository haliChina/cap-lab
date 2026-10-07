# `instrumentation` 与 `blockAutomatedBrowsers` 机制分析

Standalone 的站点密钥配置里有两个相关开关：

| 开关 | 作用 |
|---|---|
| `instrumentation` | 服务端每次生成一段**随机 JS 程序**（deflate 压缩后下发），要求客户端执行并回传 4 个变量的值 |
| `blockAutomatedBrowsers` | 额外要求回传浏览器探针向量 `p`，服务端跑 `detectAutomation()`；不合格直接 403 |

官方文档（`docs/public/agent.md`）自己的措辞是：「不是绝对保证——打过补丁的 stealth 浏览器
连 Cloudflare Turnstile 都能破——但能明显抬高门槛，挡住绝大多数现成的自动化工具」。
也就是说它卖的是「挡现成工具」，不是「挡 AI Agent」。下面是我从实现角度看到的边界。

## 程序本身做了什么

1. 服务端随机生成 4 个变量、一串按位运算（`~` / `^` / `|` / `&`、一个自定义位运算辅助函数、
   以及一个操作真实 DOM 的辅助函数），最后对 4 个变量做 salt 变换。
2. 下发前用 `deflateRawSync(level:1)` 压缩 + base64。
3. 客户端在一个 **sandbox iframe** 里解压并执行，通过 `postMessage` 回传 `{ i, state, p }`。
4. 服务端用 `verifyInstrumentationResult()` 核对 4 个值，再对 `p` 跑检测。

**一个关键实现事实**：服务端在 `generateInstrumentation()` 里是用 `domSumMock()` 把
那段 DOM 计算的答案**先算好**的，并没有真的观察你的 DOM。程序里那段操作 DOM 的代码
（建 div、appendChild、遍历 children、读 innerText）之所以能得到正确结果，是因为它同时在
两端各自算了一遍——服务端那遍是模型。于是「DOM 计算难以在浏览器外模拟」这个前提，
在实现上并不成立。

## blockChecks：14 项，每次随机抽 8 项

`buildBlockChecks()` 生成的检查里最后一行是：

```js
const sampled = checks.slice(0, Math.min(checks.length, 8));
```

即每次请求只执行 8 项，且是随机子集——这解释了同一套脚本时好时坏的现象。

| 检查 | 命中条件 |
|---|---|
| navigator 自有属性 | `Object.getOwnPropertyNames(navigator)` 里出现 `webdriver` / `userAgent` / `productSub` / `plugins` / `platform` … |
| window 前缀 | 窗口上出现 `puppeteer_` / `cdc_` / `$cdc_` 前缀属性 |
| window 标记 | `_Selenium_IDE_Recorder`、`calledSelenium`、`__webdriverFunc`、`CefSharp` … |
| document 标记 | `__selenium_evaluate`、`__webdriver_evaluate` … |
| 属性名子串 | `documentElement.getAttributeNames()` 里含 selenium/webdriver/driver |
| 栈字符串 | 栈里出现 `pptr:` / `UtilityScript.` / `PhantomJS` |
| `window.exposedFn` 源码 | Puppeteer 的 `exposeBindingHandle` 特征串 |
| `window.process` | Electron renderer |
| UA token | UA / appVersion 里出现 `HeadlessChrome` / `PhantomJS` / `SlimerJS` / `headless` |
| WebGL | vendor 与 renderer 同时等于 `Brian Paul` + `Mesa OffScreen`（headless 软渲染） |
| eval 指纹 | `Function.prototype.toString.call(eval)` 不含 `[native code]` |
| productSub | 非 `20030107` 且 UA 像 Blink |
| window 属性后缀 | 属性名以 `_Array` / `_Promise` / `_Symbol` 结尾 |
| `navigator.mimeTypes` 原型链 | 不是 `MimeTypeArray.prototype` / `MimeType.prototype` |

设计上有两点值得肯定：navigator 检查刻意区分「自有属性」与「原型 getter」，
`webdriver_stripped` 与 `window_exceeds_screen` 这两条能识别「UA 换了但其它数据没跟上」
或「viewport 被设成等于 screen」这类打补丁痕迹，专门针对第一轮修补。

## detectAutomation：9 项，跑在客户端上报的向量上

`p` 向量里的每一个字段（`ua`、`productSub`、`webdriver`、`plugins`、`engine`、`screen`、
`outerWH` / `innerWH`、`fontWidths`、`tamper` …）都是**客户端脚本自己读环境变量后组装成 JSON
POST 上来**的，服务端只对这份 JSON 做判断。

| 检查 | 默认无头 Chrome | 加固后的无头 | 手写的向量 |
|---|---|---|---|
| probe_incomplete（字段齐全） | ok | ok | ok |
| geometry_quantized（字体宽度取整） | ok | ok | ok |
| webdriver_true | **FAIL** | ok | ok |
| webdriver_stripped（Chromium 却没这个键） | ok | **FAIL** | ok |
| gecko_contradiction | ok | ok | ok |
| window_exceeds_screen | ok | **FAIL** | ok |
| viewport_override | ok | ok | ok |
| headless_token | **FAIL** | ok | ok |
| native_tamper | ok（仅 riskFlag） | ok | ok |
| **结果** | **被拦 2 项** | **被拦 2 项** | **9 项全过** |

第三列是完全不启动浏览器、手写出来的向量。`tools/detect-matrix.mjs` 可以复现这张表：
它直接调用 Cap 自己的 `detectAutomation()`，输入是四类手写向量。

## 结论

- 这一层**确实**能挡下现成的 Selenium / Puppeteer / Playwright，以及第一轮打补丁的无头浏览器。
- 但它检的是「你上报的数据像不像浏览器」，不是「你是不是在浏览器里」。
  探针是客户端生成的，服务端没有可信来源可以对照。
- 真正的成本不在检测本身，而在于：客户端必须执行服务端下发的**任意 JS**——
  这对攻击者意味着要么执行（引入远程代码执行风险），要么复刻整套随机算法
  （变量名、操作序列、salt 每次都变）。这是个持续的维护负担，也是这一层最有价值的部分。
- 叠加的时间成本很小：这一层在本地实测中是毫秒级的，token 的耗时几乎全部来自运营方
  自己选择的 PoW 难度。

要真正区分「自动化客户端」与「人」，得靠客户端无法自报的东西：服务端行为与信誉信号、
TLS + HTTP 指纹（JA3/JA4、header 顺序）、行为时序分析、Token Binding 或设备证明
（WebAuthn / TPM attestation）、以及按成本计费的风控。这些都不在 CAPTCHA 这一层的职责内。

### 本笔记的边界

以上是机制分析，我没有把「如何逐项满足这些检查」写成可运行的步骤——那部分属于攻击用法，
不在这个仓库里（见 `EXCLUDED.md`）。另外我在本地实验中也没有覆盖：`mimeTypes` 原型链
那一项、以及每项检查被随机抽中时的完整行为分布。
