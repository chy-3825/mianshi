# CCS + Clash

CC Switch 与 Clash Verge Rev 的联合源码仓库，并包含两者之间的本地连接与 Linux 桌面生命周期管理。

## 数据流

```text
Codex / Claude / Gemini
        |
        v
CC Switch (127.0.0.1:15721)
        |
        v
Clash Verge Rev / Mihomo (127.0.0.1:7897)
        |
        v
OpenAI / 其他上游服务
```

## 目录

- `cc-switch/`：CC Switch 3.20.3 定制源码，包含多账号托管认证、本地代理接管和恢复逻辑。
- `clash-verge-rev/`：Clash Verge Rev v2.5.2 源码快照（上游提交 `28f2efc5`）。
- `integration/`：两套软件的启动顺序、Clash 生命周期守护、桌面入口、systemd 用户服务和配置模板。

## Linux 快速部署

先分别按两个子项目的说明构建并安装 `/usr/bin/cc-switch` 与 `/usr/bin/clash-verge`，随后执行：

```bash
./integration/install-linux.sh
systemctl --user enable --now clash-verge-lifecycle-guard.service
~/.local/bin/start-ai-stack
```

构建 CC Switch 时，如需 Gemini OAuth refresh 功能，请由构建环境注入自己的桌面 OAuth 凭据：

```bash
export CC_SWITCH_GEMINI_OAUTH_CLIENT_ID='your-client-id'
export CC_SWITCH_GEMINI_OAUTH_CLIENT_SECRET='your-client-secret'
```

它们只在 Rust 编译时读取，不应提交到仓库。

默认端口：

- CC Switch：`127.0.0.1:15721`
- Clash mixed-port：`127.0.0.1:7897`

可通过环境变量 `CLASH_LIFECYCLE_PROXY_PORT` 修改 Clash 端口。

## 敏感数据说明

本仓库不包含本机的以下内容：

- `~/.cc-switch/` 数据库、账号与令牌；
- `~/.codex/auth.json`；
- Clash 订阅 URL、代理节点和密钥；
- 运行时日志与备份。

请将 `integration/mihomo-config.example.yaml` 复制到自己的配置位置，再填入私人订阅或节点。

## 上游与许可证

两个子目录各自保留原项目的许可证和版权文件。修改或再分发时请同时遵守各自许可证。
