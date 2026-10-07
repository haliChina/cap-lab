# 把 Cap standalone 跑起来：实操记录

目标：在一台开发机上自托管 Cap v3（`standalone/`），用于本地实验。运行环境与作者无关，
下面是踩过的坑和原因。

## 依赖

```bash
cd cap/standalone
npm install                       # 见下方「bun 的坑」
ADMIN_KEY=<至少 12 位> REDIS_URL=redis://127.0.0.1:6379 \
  SERVER_PORT=3010 SERVER_HOSTNAME=0.0.0.0 \
  bun run ./src/index.js
```

Redis / valkey 是**硬依赖**（`src/db.js` 在模块顶层就 `PING`，连不上直接退出），
存储全部走 Redis：`key:*`、`session:*`、`blocklist:*`、`metrics:*`、`rl:*`。

必填环境变量：

| 变量 | 说明 |
|---|---|
| `ADMIN_KEY` | 控制台登录密钥，至少 12 字符，否则启动即抛错 |
| `REDIS_URL` / `VALKEY_URL` | 默认 `redis://localhost:6379` |
| `SERVER_PORT` / `SERVER_HOSTNAME` | 默认 `3000` / `0.0.0.0` |
| `ENABLE_ASSETS_SERVER` | `true` 才会提供 `/assets/widget.js` 等前端资源（从 CDN 抓一次缓存进 Redis） |
| `DEMO_MODE` | `true` 时跳过鉴权，仅用于演示 |

## 运行时：bun

服务是 Bun + Elysia。**alpine / musl 环境下必须用 musl 版 bun**
（`bun-linux-aarch64-musl.zip`）；glibc 版在 musl 上会报
`ld-linux-aarch64.so.1: Not a valid dynamic program`，装 `gcompat` 也不解决。

## 装依赖：用 npm，不要用 bun install

这是最容易卡住的一步。bun 的 isolated install 在部分容器 / 沙箱环境下会把缓存文件名
改成 `.<name><hash>0001.00020001` 这样的形式，**丢掉文件扩展名**。后果是
`elysia@1.4.x` 的 `dist/index.mjs` 被当成 CommonJS 解析（它的 package.json 没有
`"type": "module"`），启动时直接：

```
SyntaxError: Export named 'Elysia' not found in module '.../dist/.l2s..l2s.index.mjs0001...'
```

`--backend=copyfile`、`--linker=hoisted`、删了重装都试过，没解决。
**改用 `npm install` 之后一切正常**（bun 只用来运行）。

## 路由地图（容易踩）

| 路径 | 说明 |
|---|---|
| `POST /server/keys` | 建站点密钥（需要 session / API token） |
| `PUT /server/keys/:siteKey/config` | 改配置（**difficulty / challengeCount / 限流只能走这里**，不是 POST） |
| `POST /:siteKey/challenge` | 取挑战 |
| `POST /:siteKey/redeem` | 提交解 |
| `POST /:siteKey?/siteverify` | 校验 token |
| `GET /assets/widget.js` | 前端 widget（需 `ENABLE_ASSETS_SERVER=true`） |
| `GET /public/*` | 静态页（tester 页面在 `/public/tester.html`，且需要先登录拿 cookie） |

鉴权头是 `Authorization: Bearer base64(JSON{token, hash})`——不是裸 token；
从 `/auth/login` 的返回里拼。

`POST /keys` 这种猜出来的路径会落到 `/:siteKey?/siteverify` 上并返回 500，看起来像服务端坏了。

## 修改前端文件后

`src/static.js` 的 `servePage` 会把 HTML 缓存在内存 Map 里，**改 `public/*.html`
必须重启进程**才生效。
