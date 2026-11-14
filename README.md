# Polaris · 全球节点探针面板

> 一个类似 [Meridian](https://github.com/Dokoyamo-Lisa/Meridian) 状态页面的轻量探针面板：
> 实时 3D 地球、延迟与可用率曲线、30 天历史、Agent 资源上报、REST API 与 MCP。
>
> **零第三方依赖**：后端只用 Node.js 内置模块，前端原生 HTML/CSS/JS，不需要构建。

![Polaris 首页](docs/preview.png)

## 这是什么

Polaris 把自己定位成 **只读的观测面板**，不接管代理协议、用户和订阅：

| | Meridian / Rosélune | Polaris |
|---|---|---|
| 定位 | 代理 / VPN 管理面板 | 探针与状态页 |
| Xray / Hysteria2 / WireGuard 部署 | 有 | 无 |
| 用户、订阅、流量计费 | 有 | 无 |
| 实时地球、延迟、可用率、30 天历史 | 有 | 有 |
| CPU / 内存 / 磁盘 / 服务状态 | 有 | 通过 Agent 上报 |
| REST API / MCP | 有 | 有 |
| 依赖 | Go 服务端 + Agent | 一个 Node 进程 |

如果你已经用 3x-ui、XrayR 或自己的脚本管节点，只缺一个“一屏看全部”的状态页，Polaris 就是为这个场景写的。
如果你需要创建用户、生成订阅、管理协议，应该直接用 Meridian 或 3x-ui。

### 功能

- **实时地球**：纯 Canvas 绘制的 3D 点阵地球，节点脉冲、中枢弧线、鼠标拖动旋转、点击节点打开详情。
- **两种探针**：服务端主动探测 HTTP / HTTPS / TCP，支持状态码白名单、关键字、TLS 证书天数；资源类指标由 Agent 反向推送。
- **30 天可用率**：按小时聚合的长期桶，按天着色；另有 1h / 24h / 7d / 30d 延迟曲线。
- **详情抽屉**：延迟趋势、区间可用率、TLS 证书、系统负载、服务状态、历史事件、节点元信息。
- **事件时间线**：连续失败达到阈值后自动开事件，恢复后自动闭环，并记录持续时长。
- **通知**：故障 / 恢复可推送通用 Webhook 或 Telegram。
- **私有面板**：密码登录 + HMAC 会话 Cookie；README 里的反向代理示例带 HSTS。
- **API 与 MCP**：只读 REST 接口；同一份数据通过 MCP 暴露给 Cursor、Claude Code 等 AI 客户端。
- **能屈能伸**：`npm run demo` 直接看演示；正式环境一个 `config.json` + 一条 `node server.mjs` 即可。

![节点详情](docs/drawer.png)

## 架构

```text
                        ┌──────────────────────────────┐
   浏览器 / API / MCP ──▶│  Polaris（单进程 Node）        │
                        │  · HTTP 静态页 + REST + MCP   │
                        │  · 主动 HTTP / TCP 探针        │
                        │  · 内存桶 + data/state.json   │
                        └───────┬──────────────▲────────┘
                                │              │
                  主动探测      │              │  Agent 反向上报
              ┌─────────────────▼──┐      ┌────┴─────────────────┐
              │ 有公网入口的节点     │      │ IPv6-only / CGNAT 节点│
              │ HTTP / TLS / TCP   │      │ CPU / 内存 / 磁盘 / 流量│
              └────────────────────┘      └──────────────────────┘
```

- **能主动连的机器**：直接配 `https` / `tcp`，由面板发起探测。
- **连不进去的机器**（纯 IPv6、100.64.x CGNAT、只放行出站）：用 Agent 往外推送。
- 面板只读取探测结果，不转发任何用户流量。

## 快速开始

要求：**Node.js ≥ 20.11**（推荐 22 LTS）。项目没有 `npm install` 步骤。

### 1. 先看演示

```bash
git clone <this-repo> polaris && cd polaris
npm run demo
# 打开 http://127.0.0.1:8787
```

演示模式使用生成的节点与历史数据，不发起真实探测，方便先看 UI。演示配置在 `config.demo.json`。

### 2. 正式使用

```bash
cp config.example.json config.json
vim config.json           # 改成你的节点
node server.mjs
```

默认只监听 `127.0.0.1:8787`。从本机访问 `http://127.0.0.1:8787`，或按下面的反向代理一节暴露到公网。

```bash
# 指定端口 / 地址
POLARIS_HOST=0.0.0.0 POLARIS_PORT=8080 node server.mjs
node server.mjs --config /etc/polaris/config.json --port 8787
```

### 3. Docker

```bash
mkdir -p data
cp config.example.json config.json
vim config.json

# 镜像内以 node 用户（UID 1000）运行，data 目录需要可写
sudo chown -R 1000:1000 data
docker compose up -d --build
curl http://127.0.0.1:8787/healthz
```

`docker-compose.yml` 只把端口绑在 `127.0.0.1`，并开启只读根文件系统、`no-new-privileges`、`cap_drop: ALL`。对外请用 Caddy / Nginx 提供 HTTPS。

### 4. systemd

```bash
sudo useradd --system --home /opt/polaris --shell /usr/sbin/nologin polaris
sudo mkdir -p /opt/polaris
sudo cp -r server.mjs src public package.json config.json /opt/polaris/
sudo chown -R polaris:polaris /opt/polaris
sudo cp deploy/polaris.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polaris
```

如果 `node` 不在 `/usr/bin/node`，修改 `deploy/polaris.service` 里的 `ExecStart`。

## 配置

顶层只有 `site`、`thresholds`、`auth`、`notifications`、`targets` 和可选的 `dataDir` / `demo`。

### site

| 字段 | 默认 | 说明 |
|---|---|---|
| `title` | `Polaris` | 页面标题 / API 名称 |
| `subtitle` | 全球节点 · 实时探针 | 副标题 |
| `tagline` | 让每一条线路，都清晰可见。 | 首页主文案 |
| `description` | 一段说明 | 首页描述 |
| `footer` | 自建探针面板 | 页脚文字 |
| `hub` | 上海 | 地球上的“探针中枢”坐标：`{ name, lat, lon }` |
| `refreshSeconds` | `10` | 节点默认探测间隔（每个节点可单独覆盖） |
| `public` | `true` | `false` 时 API 需要登录 |
| `showAddress` | `false` | 是否公开真实地址；默认打码 |
| `showDetails` | `true` | 是否公开失败原因 |
| `trustProxy` | `false` | 是否信任 `X-Forwarded-For` / `X-Forwarded-Proto`（反代后设为 true） |
| `historyDays` | `35` | 历史桶保留天数（30–90） |

### thresholds

| 字段 | 默认 | 作用 |
|---|---|---|
| `latencyWarnMs` | `350` | 超过后节点状态变“注意” |
| `cpuWarnPercent` | `80` | Agent CPU 告警阈值 |
| `memWarnPercent` | `85` | 内存告警阈值 |
| `diskWarnPercent` | `90` | 磁盘告警阈值 |
| `tlsWarnDays` | `14` | 证书剩余天数告警 |
| `failureThreshold` | `2` | 连续失败几次后判定离线并开事件 |

### targets

| 字段 | 适用 | 说明 |
|---|---|---|
| `id` | 必填 | 唯一，字母数字 `._-` |
| `name` | 必填 | 展示名称 |
| `type` | 必填 | `https` / `http` / `tcp` / `agent` |
| `url` | HTTP(S) | 完整 URL，例如 `https://example.com/health` |
| `host` / `port` | TCP / Agent | TCP 目标地址；Agent 可只写 `host` 展示 |
| `intervalSeconds` | 全部 | 5–3600，默认跟随 `site.refreshSeconds` |
| `timeoutMs` | 全部 | 1000–30000 |
| `expectStatus` | HTTP(S) | 允许的状态码数组，默认 2xx/3xx |
| `keyword` | HTTP(S) | 响应正文必须包含的关键字 |
| `allowInsecure` | HTTPS | 跳过证书校验（自签证书） |
| `agentKey` | Agent | 必填，每个节点一个随机串 |
| `country` / `city` / `group` | 全部 | 卡片与地球位置信息 |
| `lat` / `lon` | 全部 | 地球经纬度；不填则不上地球 |
| `tags` | 全部 | 展示标签 |
| `services` | Agent | 要检查的 systemd / OpenRC 单元名 |
| `hidden` | 全部 | 从面板隐藏 |
| `note` | 全部 | 备注 |

示例：

```json
{
  "id": "hk-core",
  "name": "香港 · 核心",
  "type": "https",
  "url": "https://hk.example.com/healthz",
  "country": "HK",
  "city": "香港",
  "lat": 22.3193,
  "lon": 114.1694,
  "intervalSeconds": 20,
  "expectStatus": [200],
  "keyword": "ok",
  "tags": ["主力", "Reality"]
}
```

```json
{
  "id": "sg-agent",
  "name": "新加坡 · 落地",
  "type": "agent",
  "agentKey": "换成 openssl rand -hex 24 的输出",
  "country": "SG",
  "city": "新加坡",
  "lat": 1.3521,
  "lon": 103.8198,
  "intervalSeconds": 20,
  "services": ["nginx", "xray"]
}
```

> TCP 探针只测 TCP 连通性。Hysteria2 / WireGuard 是 UDP，无法用 TCP 探测；请用 Agent 上报进程状态，再从客户端侧另行验证。

### 私有模式

```bash
node tools/hash-password.mjs '你的强密码'
```

把输出的 `site.public: false` 和 `auth.passwordSha256` 写进 `config.json`。建议同时设置一个随机的 `auth.mcpToken`，供 MCP 客户端使用：

```json
{
  "site": { "public": false, "trustProxy": false },
  "auth": {
    "passwordSha256": "……",
    "sessionHours": 12,
    "mcpToken": "另一个随机串"
  }
}
```

会话 Cookie 使用 HMAC 签名，密钥自动生成在 `data/session-secret`。私有模式下静态资源仍然公开（登录页需要），所有 `/api/*` 与 MCP 数据会校验登录或 Bearer Token。

### 通知

```json
{
  "notifications": {
    "webhookUrl": "https://example.com/hooks/polaris",
    "telegram": { "botToken": "123:ABC", "chatId": "123456789" },
    "notifyOnRecovery": true,
    "timeoutMs": 8000
  }
}
```

- Webhook 收到 `{ source, event, sentAt, node, incident }`，`event` 为 `incident.opened` 或 `incident.resolved`。
- 通知在事件开/关时异步发送，失败只写日志，不影响探测。
- 想接飞书 / 钉钉 / Slack，用 `webhookUrl` 指向你的转发服务即可。

## Agent

Agent 是一个纯 Bash 脚本，适用于大多数 Linux。`install-agent.sh` 面向 systemd（Debian / Ubuntu / Rocky 等）；Alpine 等 OpenRC 系统请手动把脚本和 env 文件放好，并用 OpenRC 或 supervisor 常驻。

```bash
# 在面板配置里给节点填好 agentKey，然后在目标机上：
sudo POLARIS_SERVICES="nginx xray" \
     POLARIS_MOUNTS="/ /var" \
     ./agent/install-agent.sh https://status.example.com <AGENT_TOKEN>

# 看日志
journalctl -u polaris-agent -f
```

也可以手动运行：

```bash
POLARIS_URL=https://status.example.com \
POLARIS_TOKEN=<AGENT_TOKEN> \
POLARIS_SERVICES="nginx xray" \
POLARIS_MOUNTS="/" \
bash agent/polaris-agent.sh --once

# 只打印将上报的 JSON（排查用）
POLARIS_URL=https://... POLARIS_TOKEN=... bash agent/polaris-agent.sh --print
```

上报内容：主机名、系统、内核、运行时长、CPU 使用率 / 核心数 / 型号、内存、挂载点使用率、网卡累计流量、负载、systemd / OpenRC 服务状态。间隔由 `POLARIS_INTERVAL` 控制，最小 5 秒。

安装文件：

- `agent/polaris-agent.sh`：脚本本体
- `agent/polaris-agent.env.example`：环境变量示例（安装后为 `/etc/polaris-agent.env`，权限 600）
- `agent/polaris-agent.service`：systemd 单元
- `agent/install-agent.sh`：一键安装

Agent 是**只读**的：只读取 `/proc`、`df` 和 `systemctl is-active`，不会修改系统；但 unit 默认以 root 运行（服务状态检查最省事），已加 `ProtectSystem=strict` 等加固。不需要服务检查时可以把 `POLARIS_SERVICES` 留空，并考虑改成非 root 用户。

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览：summary + 所有节点 + 今日/30 天数据 |
| GET | `/api/targets/:id?range=1h\|24h\|7d\|30d` | 节点详情与时间序列 |
| GET | `/api/incidents?limit=20` | 事件列表 |
| GET | `/api/healthz` | 健康检查（无需登录） |
| GET | `/api/session` | 当前登录状态 |
| POST | `/api/login` / `/api/logout` | 私有模式的登录 / 退出 |
| POST | `/api/agent/report` | Agent 上报（Bearer Token） |
| GET / POST | `/mcp` | MCP 元信息 / JSON-RPC |

```bash
curl -s https://status.example.com/api/overview | jq '.summary'
curl -s "https://status.example.com/api/targets/hk-core?range=24h" | jq '.summary'
curl -s "https://status.example.com/api/incidents?limit=10" | jq
```

私有模式使用 Cookie 或先登录：

```bash
curl -c cookies.txt -X POST https://status.example.com/api/login \
  -H 'content-type: application/json' -d '{"password":"..."}'
curl -b cookies.txt https://status.example.com/api/overview | jq
```

### Agent 上报格式

```json
{
  "hostname": "sg-01",
  "platform": "Debian GNU/Linux 12 (bookworm)",
  "kernel": "6.1.0-28-amd64",
  "agentVersion": "1.0.0",
  "uptimeSeconds": 864000,
  "cpu": { "usage": 37.5, "cores": 4, "model": "AMD EPYC 7B13" },
  "memory": { "total": 8589934592, "used": 3221225472 },
  "disks": [{ "mount": "/", "total": 85899345920, "used": 30064771072, "percent": 35 }],
  "net": { "rxBytes": 1000000000, "txBytes": 500000000 },
  "load": [0.4, 0.3, 0.2],
  "services": [{ "name": "nginx", "active": true }],
  "latencyMs": 12.5
}
```

`latencyMs` 可选；其余字段缺失时按空值处理。服务端会做长度、百分比和数值范围清洗。

## MCP

`GET /mcp` 返回能力清单；`POST /mcp` 接受 JSON-RPC 2.0（Streamable HTTP，`application/json` 响应）。

工具：

| 工具 | 作用 |
|---|---|
| `overview` | 网络总览与所有节点摘要 |
| `list_nodes` | 按状态 / 类型 / 地区过滤节点 |
| `get_node` | 单节点详情（含事件、证书、资源） |
| `get_history` | 延迟 / 可用率时间序列 |
| `list_incidents` | 最近故障事件 |

Cursor：

```json
{
  "mcpServers": {
    "polaris": {
      "url": "https://status.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Claude Code：

```bash
claude mcp add --transport http polaris https://status.example.com/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Claude Desktop（需要 `mcp-remote` 转接）：

```json
{
  "mcpServers": {
    "polaris": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://status.example.com/mcp",
        "--header", "Authorization: Bearer <MCP_TOKEN>"
      ]
    }
  }
}
```

也可以用 `curl` 直接验证：

```bash
curl -s https://status.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <MCP_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"overview","arguments":{}}}' | jq
```

## 暴露到公网

面板自身只监听 `127.0.0.1`，建议用 Caddy 或 Nginx 终止 TLS：

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddyfile / Nginx 示例都在 `deploy/`。使用反向代理时：

1. 把 `site.trustProxy` 设为 `true`；
2. 确认 `X-Forwarded-Proto` 被正确传递（示例已配置）；
3. 只有这样才能得到正确客户端 IP、`Secure` Cookie 和 HSTS。

安全建议：

- 不要把面板端口直接暴露公网；先在 TLS 后面，再考虑 `site.public: false`。
- 密码用 16 位以上随机串；`auth.mcpToken` 单独生成，不要复用。
- 每个 Agent 使用独立 `agentKey`；泄露后只改该节点并 reload。
- 定期备份 `config.json` 和 `data/`。
- 面板不代理流量，但仍会暴露节点名称、地区和可用率；`showAddress: false` 会打码地址，但 TLS 证书的 subject 仍可能包含域名。

## 数据与保留

- 内存是主存储，`data/state.json` 每 20 秒原子快照一次（先写临时文件再 rename），进程退出时也会保存。
- 每台节点保留最近 35 天的**小时桶**（在线数、检查数、延迟求和、CPU/内存/磁盘、流量增量）和最近 180 个原始采样。
- 事件最多保留 300 条。
- 想清空历史：停止服务，删除 `data/state.json`（不要删 `data/session-secret`，否则所有人需要重新登录）。
- 演示数据在 `data/demo/`，正式数据在 `data/`，互不影响。

## 项目结构

```text
polaris/
├── server.mjs              # CLI 入口：加载配置、启动探针/演示、监听
├── src/
│   ├── app.mjs             # HTTP 路由：静态页、REST、登录、MCP
│   ├── config.mjs          # 配置校验与归一化
│   ├── store.mjs           # 采样、小时桶、30 天、事件、持久化
│   ├── probe.mjs           # HTTP / HTTPS / TCP 探针与调度器
│   ├── demo.mjs            # 确定性演示数据
│   ├── auth.mjs            # 密码、HMAC 会话、Bearer
│   ├── mcp.mjs             # MCP tools / resources
│   ├── notify.mjs          # Webhook / Telegram
│   └── util.mjs
├── public/
│   ├── index.html          # 单页结构
│   ├── style.css           # 设计系统与响应式
│   ├── app.js              # 数据获取、渲染、抽屉、登录
│   ├── globe.js            # Canvas 3D 点阵地球
│   ├── charts.js           # SVG 迷你曲线 + Canvas 时序图
│   └── globe-land.js       # 由 Natural Earth 110m 生成的点阵（构建产物）
├── assets/land-110m.json   # Natural Earth 110m 陆地拓扑（点阵数据源）
├── agent/                  # Bash Agent + systemd + 安装脚本
├── deploy/                 # systemd / Nginx / Caddy 示例
├── test/                   # node:test 单元与集成测试
├── tools/
│   ├── build-globe.mjs     # TopoJSON → 点阵位图
│   ├── hash-password.mjs   # 生成密码哈希
│   └── screenshot.mjs      # 可选的 CDP 截图工具
├── config.demo.json
├── config.example.json
├── Dockerfile
└── docker-compose.yml
```

## 开发

```bash
npm test          # 21 个测试：配置、探针、存储、API、MCP、通知
npm run demo      # 演示模式
npm run build:globe
```

> 测试使用 `node --test --test-isolation=none`（Node 22.8+）。默认的 `node --test` 会为每个测试文件再启动一个 Node 进程，在某些受限沙箱里会被拒绝；同进程运行没有这个问题。Node 20 上可以逐个运行 `node test/*.test.mjs`。

前端没有构建步骤；改了 `public/` 刷新即可。改地球数据后运行 `npm run build:globe`，会从 `assets/land-110m.json` 重建 `public/globe-land.js`。

`tools/screenshot.mjs` 是一个可选的开发脚本，配合 `msedge --headless --remote-debugging-port=9222` 使用，用于生成 README 截图，不影响运行。

## 常见问题

**Agent 一直显示“待探测”**
先确认 `config.json` 里的 `agentKey` 与 `/etc/polaris-agent.env` 的 `POLARIS_TOKEN` 完全一致，再 `journalctl -u polaris-agent -f` 看是否 401。Agent 第一次上报前就是待探测状态。

**节点在线但 30 天可用率是 0**
该节点刚加入，还没有跨小时的桶；等一小时或看 1h 曲线。演示模式会预填 30 天数据。

**纯 IPv6 / CGNAT 节点探测不到**
面板主动探测需要能路由到目标。这类机器请用 `type: "agent"`，让目标主动往外推。

**Hysteria2 / WireGuard 显示离线**
TCP 探针测不了 UDP。把节点改成 Agent，用 `services` 检查进程，再从客户端侧验证实际连通。

**反向代理后登录刷新又掉线**
把 `site.trustProxy` 设为 `true`，并确认代理传递了 `X-Forwarded-Proto: https`；否则 Cookie 不会带 `Secure`（或不匹配）。

**收不到通知**
检查 `notifications.webhookUrl` / Telegram 配置；发送失败只写日志，不影响面板。先用一个 `nc -l` 或 webhook.site 验证连通性。

**地球上看不到某些节点**
地球只渲染朝向镜头的一面，拖动旋转即可；标签在重叠时会自动隐藏部分，点击节点或卡片仍可查看详情。

**为什么没有用户 / 订阅 / 流量计费**
这不是代理面板。Polaris 只做观测；需要这些能力请使用 Meridian、3x-ui 或 Marzban。

## License

MIT. 地球点阵使用 Natural Earth 110m 陆地数据（public domain），通过 [world-atlas](https://github.com/topojson/world-atlas) 转换。
