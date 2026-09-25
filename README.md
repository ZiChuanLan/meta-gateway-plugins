# meta-gateway-plugins

meta-gateway 的**官方插件注册表**，同时也是**官方插件（`demo-plugin` / `jev-router`）的源码仓库**。

meta-gateway 控制台的「拓展 → 插件市场」默认从这里读 `registry.json`（`DefaultMarketURL` 指向本仓 `main` 分支的该文件），列出可一键安装的插件。

## 目录结构

```
├── registry.json                  # 插件注册表（meta-gateway 市场读取此文件）
├── dist/                          # direct 安装方式的发布包（被 registry 的 url 指向，需提交）
├── plugins/                       # 官方插件源码（每个插件一个独立 module）
│   ├── demo-plugin/
│   │   ├── main.go                # 协议参考实现
│   │   ├── plugin.json            # 打包进 zip 的 manifest（entrypoint + run_args）
│   │   └── build-release.ps1      # 构建 → dist/，并打印 registry.json 需要的那段 JSON
│   └── jev-router/
│       ├── main.go                # TypeSafe Jev 自动选路（虚拟模型名可在配置里改，默认 auto-jev）
│       ├── main_test.go
│       ├── build-release.ps1      # 交叉编译 + 打包（manifest 由二进制 -dump-manifest 输出）
│       └── README.md              # 配置项、场景路由、降级语义
├── scripts/validate_registry.py   # CI：条目 ↔ 发布包 的 sha256/size 一致性
└── .github/workflows/ci.yml
```

**插件源码不一定要住在本仓。** 本仓是「官方注册表 + 官方插件源码」；第三方插件放自己的仓库即可，见文末。

## 两种插件形态

| | sidecar 直连 | 托管进程包 |
| --- | --- | --- |
| 条目字段 | `url`（指向已运行的服务） | `install`（`direct`）或只有 `repository`（默认 `github-release`） |
| 谁启动进程 | 你自己（或 Docker/宿主机） | 网关：下载 → 校验 → 解压 → 拉起子进程 → 健康检查 |
| 适用 | 已有服务、任意语言、任意地址 | 一键安装 |

托管安装时网关会：预留空闲端口并通过环境变量/启动参数交给插件 → 注入 `META_GATEWAY_PLUGIN_*`（含随机 `X-Plugin-Key`）→ 健康检查那个地址 → 在控制台 iframe 内嵌页面并反代 API。

## registry.json 格式（v2）

```json
{
  "schema_version": 2,
  "plugins": [
    {
      "id": "demo-plugin",
      "name": "Demo Plugin",
      "version": "1.0.0",
      "install": {
        "type": "direct",
        "artifacts": [
          {
            "goos": "linux",
            "goarch": "amd64",
            "url": "https://raw.githubusercontent.com/ZiChuanLan/meta-gateway-plugins/main/dist/demo-plugin_1.0.0_linux_amd64.zip",
            "sha256": "<sha256 of the zip>",
            "size": 4816511
          }
        ]
      }
    }
  ]
}
```

- `type: direct`：从 `artifacts[].url` 下载安装包（zip），`sha256` + `size` 双重校验。`scripts/validate_registry.py` 在 CI 里对**每个**平台校验一遍（网关只在它自己要装的那个平台上校验）。
- `type: github-release`（**不写 `install` 时的默认值**，前提是条目里有 `repository`）：从 GitHub Release 解析资产，取 `{id}_{version}_{goos}_{goarch}.zip` 与 `checksums.txt`（`artifact_pattern` / `checksum_asset` 可覆盖）。
- **带 `url` 且无 `install`** 的是旧版 sidecar 条目（指向已运行的 HTTP 服务），不推荐新插件使用。
- 同时带 `url` 与 `install` 是无效条目（`install.type` 优先，`url` 会被忽略）——CI 直接拒绝，避免看起来像 sidecar 其实在装包。
- 可选字段：`versions[]`（`direct` 的历史版本）、`permissions`、`tags`、`author`、`homepage`、`logo`、`license`、以及旧版 sidecar 用的 `page_path` / `health_path` / `api_prefix` / `channel_path` / `config_fields`。

## 托管进程插件安装包（zip）

zip 必须是以下结构（条目在根目录）：

```
plugin.json          # 插件清单
demo-plugin          # entrypoint 可执行程序
```

`plugin.json` 字段（meta-gateway 的 `SidecarManifest`，见 `internal/plugins/service.go`）：

```json
{
  "id": "demo-plugin",
  "version": "1.0.0",
  "name": "Demo Plugin",
  "description": "...",
  "capabilities": ["admin_page"],
  "page_path": "/",
  "health_path": "healthz",
  "entrypoint": "demo-plugin",
  "run_args": ["-addr", "{addr}", "-key", "{key}"]
}
```

- `entrypoint`：zip 内的可执行文件名。**必须写目标平台的真实文件名** —— Windows 带 `.exe`（`jev-router.exe`），Linux/macOS 不带。网关解压后会拿它去对文件做检查（`validatePluginManifestForPackage`），写错就是 `plugin_manifest_entrypoint_missing`：Linux 上装得好好的，Windows 上直接失败。所以两个 `build-release.ps1` 都按目标平台改写这份清单，而不是照搬一份固定值。
- `run_args`：启动参数，占位符 `{addr}`/`{port}`/`{id}`/`{plugin_dir}`/`{key}` 由 meta-gateway 启动时替换。`{addr}` 是网关分配的 `127.0.0.1:<随机端口>`。
- 钩子插件另需 `permissions: ["relay:intercept"]` 与 `hooks`（见 `plugins/jev-router`）。
- 钩子声明里可选 `models_path`：指向插件侧一个 GET 端点，返回 `{"models":[…]}`（也接受
  `{"data":[{"id":…}]}`）。网关在注册、启用、保存配置、启动与每 30 秒拉取该名单，用它替代
  `match_models` 作为钩子匹配与 `/v1/models` 发布的依据（拉取失败时回退到清单声明列表）。
  模型名跟着插件自己的配置走的插件用它——网关不需要、也不应该知道任何具体插件的配置键
  （jev-router 的 `model_name` 就是这样接的）。声明了 `models_path` 的钩子其 `match_models`
  变为可选。

## 版本与 tag 约定（本仓只有一条发布流水线）

发版 = **打 tag 推上去**：`.github/workflows/release.yml` 会在 tag 上先跑一遍 gofmt/vet/test 与注册表校验，再按注册表里 `github-release` 的插件逐个调用它们的 `build-release.ps1` 打包，把 zip 与合并后的 `checksums.txt` 作为 Release 资产上传。

网关解析 Release 的规则是：**条目 `version` 为空 → `releases/latest`；有版本 → `releases/tags/v{version}`**（`internal/plugins/market_install.go`）。tag 名是仓库级的，所以：

- **两个插件不能各占一个 `v1.0.0`。** 发行要么把该次要发的插件包放进**同一个** release，要么让它们的版本号互不相同（`v1.0.1`、`v1.0.2` 各自一个 release 也行）。
- `checksums.txt` 可以同时列出多个插件的包，网关按文件名查表。
- 条目里的 `version` 必须与 tag 对得上（tag = `v` + `version`）。

## 构建官方插件

```powershell
# 托管进程包（github-release）：产出 plugins/jev-router/dist/，整份上传到 Release
cd plugins/jev-router
./build-release.ps1 -Version 1.0.0

# direct 包：产出仓库根 dist/，并打印要粘贴进 registry.json 的 artifact 段
cd plugins/demo-plugin
./build-release.ps1 -Version 1.0.1
```

`plugins/*/dist/` 与 `plugins/*/.build/` 是构建输出，已在 `.gitignore` 里：github-release 的交付物是 **Release 资产**，direct 的交付物是 **`dist/` 里那个被提交的 zip**，二者不重复存放。

jev-router 的 zip 里 `plugin.json` 由二进制自己 `-dump-manifest` 输出（不会与运行时不一致）；demo-plugin 的 `plugin.json` 是仓库里维护的文件（它用 `entrypoint` + `run_args` 描述「怎么被拉起」，与它运行中服务的 manifest 不是同一组字段）。

## 第三方插件怎么接

**不需要把源码提进本仓**，也不存在「必须先 PR 到这里」的说法：

1. **完全自助**：插件放你自己的仓库 → 打 Release（或任意可下载 URL）→ 写自己的 `registry.json` → 用户在网关侧用 `PLUGIN_MARKET_URLS` 追加你的地址即可（逗号分隔；`docker-compose.yml` 与 `.env.example` 都有这个变量）。网关的安装 API 还支持 `?source=` 指定来源。
2. **进官方市场列表**：往本仓 `registry.json` 提**一条 JSON 条目**（`repository` 指向你的仓库），不提交源码、不提交包、不需要维护者 review 你的实现。
3. **sidecar 直连**：管理员在控制台「拓展 → 注册插件」里填地址即可，完全不需要 registry。

协议参考实现是 `plugins/demo-plugin`；实际用起来的例子是 `plugins/jev-router`。

## CI

`.github/workflows/ci.yml` 对每个 plugin module 跑 `gofmt -l` / `go vet ./...` / `go test ./...`，再用 `scripts/validate_registry.py` 校验注册表条目与它指向的发布包（存在性、sha256、size、id 唯一性、条目形态）。Go 版本与网关保持同一 minor。

本地等价：

```bash
for d in plugins/*/; do (cd "$d" && gofmt -l . && go vet ./... && go test ./...) || exit 1; done
python3 scripts/validate_registry.py
```

## 溯源

`plugins/demo-plugin` 与 `plugins/jev-router` 原在 meta-gateway 主仓 `tools/plugins/`（分别由 `e2a055a`、`fee1741` 引入），迁入本仓后主仓只保留主程序。主仓侧对应协议定义：`internal/plugins/`（manifest、钩子、托管进程）与 `internal/proxy/hooks.go`（拦截契约）。

⚠️ **没有机器校验的协议版本。** `SidecarManifest` 里没有协议/API 版本字段，网关也不会拒绝「按旧契约写的插件」。跨仓之后对齐只能靠人：本仓 CI 只保证每个插件自身可编译、可测（`gofmt` / `go vet` / `go test`），不保证它与当前网关版本兼容。网关侧改动 `internal/plugins/hooks.go`、`internal/proxy/hooks.go`、manifest 字段时，两个仓要一起看。
