# opencode-host（显示名：订阅账号宿主）

在 meta-gateway 里**直接运行其他作者的 OpenCode 订阅插件**，把它们的订阅变成网关的一条上游渠道。

它不移植、不改写、不重新实现任何厂商：那些包（`@magpie-community/*`，以及任何按 OpenCode provider plugin 接口写的包）由作者维护，这里只负责装、登录、转发。

## 它做什么

| 环节 | 谁做 |
| :--- | :--- |
| 订阅的协议、鉴权刷新、模型清单、厂商特定的请求塑形 | **插件包作者** |
| 安装（npm）、登录、账号存储、模型路由、把 OpenAI 请求交给插件 | 本宿主 |
| 路由、故障转移、计费、日志、渠道管理 | meta-gateway |

所以「支持一家新厂商」= 在控制台里装一个包 + 登录一次，**不需要改本仓库，也不需要编译**。

## 形态

一个 meta-gateway sidecar：任何 HTTP 服务，声明 `channel_path: "/v1"`，网关就会把它当上游渠道用。

| 端点 | 作用 |
| :--- | :--- |
| `/plugin.json` | 网关注册时读的 manifest |
| `/healthz` | 健康检查 |
| `/v1/models` | 聚合所有已登录 provider 的模型，名字是 `<provider>/<model>` |
| `/v1/chat/completions` | 转发；流式原样透传 |
| `/api/*` | 管理接口（安装、登录、启停），需要 `X-Plugin-Key` |
| `/` | 管理页，控制台 iframe 内嵌 |

## 跑起来

**推荐：从插件市场装。**

控制台 **拓展 → 插件市场 → 订阅账号宿主 → 安装**。网关下载那个包（15 KB，一个文件、不分平台）、校验 sha256、解包，然后用**它自己的 Node** 拉起 `node src/host.mjs` 并等 `/healthz`；装完点插件卡片就是它自己的管理页。

包本身只有程序，没有运行时：`plugin.json` 的 `entrypoint` 是裸名 `node`，由网关提供解释器（`internal/plugins/process.go` 的 `pluginEntrypoint`：包里有同名文件就用包里的，没有且是裸名就去 PATH 上找）。所以同样一个 zip 在 amd64、arm64、macOS、Windows 上都是同一个。

一台能跑它的机器需要：

| 依赖 | 为什么 |
| :--- | :--- |
| `node` | 宿主本体（官方网关镜像自带；裸机跑二进制的话自己装，Alpine 3.22 给的是 22.x，实测可用） |
| `tar` | 安装 npm 包时解 `.tgz`（busybox 的够用；Windows 自带 `tar.exe` 也行） |
| CA 证书 | 访问 `registry.npmjs.org` 要用 HTTPS |

> **不需要 npm。** 装 npm 包走的不是 npm，而是「读 registry 元数据 → 下载 tarball → `tar` 解开」——这些包按仓库约定不带依赖，所以没有要解析的依赖树；真带了依赖的包会被明确拒绝并提示用 npm 装。

开发时直接跑源码：

```bash
node src/host.mjs          # DATA_DIR 由 META_GATEWAY_PLUGIN_DIR 指定，端口由 META_GATEWAY_PLUGIN_PORT 指定
```

托管运行时网关会注入 `META_GATEWAY_PLUGIN_{ID,DIR,ADDR,PORT,KEY}`；手动起的话自己设这几个环境变量：

```bash
META_GATEWAY_PLUGIN_DIR=$PWD/data META_GATEWAY_PLUGIN_PORT=9300 META_GATEWAY_PLUGIN_ADDR=127.0.0.1 META_GATEWAY_PLUGIN_KEY=pick-a-long-one node src/host.mjs
```

> **`META_GATEWAY_PLUGIN_KEY` 必须设**，否则只能绑回环：绑到 `0.0.0.0` 而不带密钥会被拒绝启动（`refusing to listen on 0.0.0.0 without META_GATEWAY_PLUGIN_KEY`）。密钥同时守住 `/v1` —— 没有它，任何能连到这个端口的人都能花你的订阅额度、往插件目录里装包。

然后 **拓展 → 注册 sidecar** 填 `http://127.0.0.1:9300`，再去「创建渠道」（地址与密钥会自动填成 `http://127.0.0.1:9300/v1`）。

数据都落在 `META_GATEWAY_PLUGIN_DIR`：`host.json`（装了哪些包）与 `auth.json`（登录凭据，0600）。

## 发版

```powershell
./build-release.ps1 -Version 0.3.0     # 一个 zip（约 15 KB）落到 plugins/opencode-host/dist/，连同 checksums.txt
```

包里是 `plugin.json` + `package.json` + `src/host.mjs` + `public/index.html`，**不分平台**。registry 条目用 `install.artifact_pattern: "{id}_{version}.zip"` 告诉安装器名字里没有 goos/goarch；资产挂到 `v{version}` 这个 Release，`dist/` 不进 git。

## 用

1. 管理页里填 npm 包名 → **安装**（例如 `@magpie-community/opencode-zen-free-auth`、`@magpie-community/opencode-zcode-auth`）
2. 该包声明的 provider 出现在**登录**区 → 点登录（`api` 类型填/确认密钥，`oauth` 类型走浏览器流程）
3. 登录后 `/v1/models` 就有它的模型，名如 `opencode-zen-free/cat-jam-free`
4. 在网关里给这些模型名建路由即可

> **模型名要带 provider 前缀。** 一个宿主可以同时跑很多家；前缀是唯一的「这条请求给谁」。只有一个 provider 时，不带前缀的名字会直接交给它。

## 契约（宿主实现了什么）

插件包按 OpenCode 的 provider plugin 接口写：

```js
export const MyPlugin = async (input) => ({
  config(cfg) {},                       // 可选：注册 provider 配置
  auth: {
    provider: "my-provider",
    methods: [{ type: "api", label, placeholder, authorize() }, { type: "oauth", authorize() }],
    async loader(getAuth) {             // 每次请求都调用，作者可以在这里刷新
      return { baseURL, apiKey, fetch(input, init) -> Response }
    },
  },
  provider: { id, async models(conf, { auth }) { return { "model-id": {...} } } },
})
```

- `loader` 返回的 `{baseURL, apiKey}` 决定请求打到哪里；它没有自带 `fetch` 时，宿主用 `Authorization: Bearer <apiKey>` 直发。
- `authorize()` 返回 `{type:"success", key}` 的 `api` 登录会被原样采信（Zen 的 `public` 就是这样一次点击完成）。
- `oauth` 的 `authorize()` 返回 `{url, instructions, callback(code)}`；宿主把 URL 交给操作员，拿回来的 code 交给 `callback`。
- 签名只经 `getAuth()` 读，宿主不缓存：作者若在 `fetch` 里换了 token 并 `client.auth.set`，下一次请求就看到。

## 边界（写在这里，免得踩）

- **一个 provider 一个账号。** 同一家多账号还没做，需要时再加（`provider#2` 的形状）。
- **OAuth 的自动续期没有单独实现**：刷新逻辑在包自己的 `loader`/`fetch` 里，宿主每次请求都会重新调 `loader`。包不刷新就得重新登录。
- **`$`（Bun shell）不可用**：需要跑命令的包（少数要调厂商 CLI 的）会拿到一个抛错函数。
- **信任模型**：宿主在进程内跑第三方 JS。和所有 sidecar 一样，只装你信任的包。具体边界：
  - 进程只有环境变量白名单（`ADMIN_TOKEN` / `MASTER_KEY` 不传，见主仓 `filterPluginEnv`），监听地址由网关指定且默认 `127.0.0.1`；
  - 但没有沙箱：包能读写自己的插件目录、能访问网络、能花掉已登录的订阅额度。它不是安全边界，进程边界才是；
  - 装包只从 `registry.npmjs.org` 取，tarball 必须是 HTTPS 且 host 就是这个域名，单包上限 32 MiB，解包前先列成员（绝对路径、`..`、符号/硬链接一律拒绝）；
  - `PLUGIN_KEY` 守着 `/v1` 与 `/api`；不设密钥只能绑回环，绑 `0.0.0.0` 会直接拒绝启动。
- **管理页跑在沙箱 iframe 里**：控制台的 `PluginHost` 用 `sandbox="allow-scripts allow-forms …"`（**没有** `allow-same-origin`），所以页面是 opaque origin，相对路径的 `fetch` 也是跨域——宿主必须回 CORS 头，页面自己要把 URL 上的 `?t=` 带到每个请求里（`api()` 里那两行）。缺任何一条的表现都是“页面能打开，然后每块都写 Failed to fetch”。
- **网络**：宿主所在进程要能访问厂商；容器里部署时注意它走的是容器网络。

## 测试

```bash
node --test test/host.test.mjs
```

11 个用例，都跑在本地夹具包上、不需要联网：manifest、登录后经插件 `fetch` 转发、流式透传、未知 provider 前缀拒绝、手填模型放行、`X-Plugin-Key` 与 `Authorization: Bearer <key>` 两种凭据、`/v1` 不带密钥 401、无密钥绑 `0.0.0.0` 被拒、`META_GATEWAY_PLUGIN_ADDR` 里带端口时仍能监听、以及沙箱 iframe 需要的 CORS 与预检。
