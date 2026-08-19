# meta-gateway-plugins

meta-gateway 的官方插件注册表（registry）。meta-gateway 的「插件市场」从这里读取 `registry.json`，列出可安装插件。

## 目录结构

```
├── registry.json                      # 插件注册表（meta-gateway 市场读取此文件）
└── dist/
    └── demo-plugin_1.0.0_linux_amd64.zip   # 托管进程插件安装包
```

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
            "url": "https://raw.githubusercontent.com/.../demo-plugin_1.0.0_linux_amd64.zip",
            "sha256": "<sha256 of the zip>",
            "size": <byte size of the zip>
          }
        ]
      }
    }
  ]
}
```

- `type: direct`：直接从 `artifacts[].url` 下载安装包（zip），`sha256` + `size` 双重校验。
- `type: github-release`：从 GitHub Release 解析资产 + `checksums.txt`（见 meta-gateway `docs/PLUGINS.md`）。
- 带 `url` 字段且无 `install` 块的条目标是旧版 sidecar（指向已运行的 HTTP 服务），不推荐新插件使用。

## 托管进程插件安装包（zip）

zip 必须是以下结构（条目在根目录）：

```
plugin.json          # 插件清单
demo-plugin          # entrypoint 可执行程序
```

`plugin.json` 字段（meta-gateway `SidecarManifest`）：

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
  "run_args": ["-addr", "{addr}"]
}
```

- `entrypoint`：zip 内的可执行文件名。
- `run_args`：启动参数，占位符 `{addr}`/`{port}`/`{id}`/`{plugin_dir}`/`{key}` 由 meta-gateway 启动时替换。`{addr}` 是网关分配的 `127.0.0.1:<随机端口>`。
- 可选：` api_prefix`、`channel_path`、`permissions`、`config_fields`。

安装后 meta-gateway 会：下载 zip → 校验 sha256/size → 安全解包 → 拉起 `entrypoint`（子进程，注入 `META_GATEWAY_PLUGIN_*` 环境变量）→ 健康检查 → 在控制台 iframe 内嵌页面并反代 API。

## demo-plugin 源码

参考实现位于 meta-gateway 主仓库 `tools/plugins/demo-plugin`。重新构建：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o demo-plugin .
# 将 demo-plugin + plugin.json 打包为 zip，然后更新 registry.json 的 sha256/size
```