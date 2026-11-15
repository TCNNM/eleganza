#!/usr/bin/env bash
# Eleganza 面板一键安装（Linux + systemd）
#
# 一行安装：
#   curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/deploy/install-panel.sh \
#     | sudo bash
#
# 安装时会询问：
#   1. 绑定公网 IP（http://IP:8787）
#   2. 绑定域名（http://域名:8787，需要 DNS 指向本机）
#
# 可选环境变量：
#   ELEGANZA_BIND=ip|domain     非交互式指定访问方式
#   ELEGANZA_IP=1.2.3.4         绑定 IP 模式下的公网 IP
#   ELEGANZA_DOMAIN=status.example.com  绑定域名模式下的域名
#   ELEGANZA_DIR=/opt/eleganza  安装目录
#   ELEGANZA_PORT=8787          监听端口
#
# 安装完成后：
#   1. 用终端打印的初始化令牌打开面板初始化管理员，或
#   2. 运行 sudo -u eleganza node tools/create-admin.mjs admin
#   3. 编辑 /opt/eleganza/config.json 添加节点后重启 eleganza
set -euo pipefail

REPO_URL="https://github.com/TCNNM/eleganza.git"
TARBALL_URL="https://codeload.github.com/TCNNM/eleganza/tar.gz/refs/heads/main"
INSTALL_DIR="${ELEGANZA_DIR:-/opt/eleganza}"
PORT="${ELEGANZA_PORT:-8787}"
SERVICE="eleganza"

if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ELEGANZA_PORT 无效：$PORT" >&2
  exit 2
fi
if [ "$PORT" -lt 1024 ]; then
  echo "端口 $PORT 小于 1024，服务以 eleganza 普通用户运行无法绑定。" >&2
  echo "请使用 8787 等高位端口，再用 Caddy / Nginx 反向代理到 80/443。" >&2
  exit 2
fi

usage() {
  cat <<'USAGE'
用法:
  curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/deploy/install-panel.sh | sudo bash

安装时会询问绑定公网 IP 还是域名。

非交互式示例:
  curl ... | sudo env ELEGANZA_BIND=ip ELEGANZA_IP=1.2.3.4 bash
  curl ... | sudo env ELEGANZA_BIND=domain ELEGANZA_DOMAIN=status.example.com bash

可选环境变量:
  ELEGANZA_BIND=ip|domain
  ELEGANZA_IP=1.2.3.4
  ELEGANZA_DOMAIN=status.example.com
  ELEGANZA_DIR=/opt/eleganza
  ELEGANZA_PORT=8787
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "请用 root 运行（sudo）。" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统没有 systemd。请使用 Docker 或手动运行 server.mjs。" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 Node.js。请先安装 Node.js >= 20.11（推荐 22 LTS），再重新执行。" >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")"

if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=11)?0:1)'; then
  echo "Node.js 版本过低：$("$NODE_BIN" -v)（需要 >= 20.11）" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "需要 git，或 curl/wget 中的至少一个，用于下载源码。" >&2
  exit 1
fi

BIND_MODE="${ELEGANZA_BIND:-}"
PUBLIC_IP="${ELEGANZA_IP:-}"
DOMAIN="${ELEGANZA_DOMAIN:-}"
BIND_HOST="0.0.0.0"
PUBLIC_URL=""

read_tty() {
  local prompt="$1"
  local default_value="${2:-}"
  local answer=""
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    return 1
  fi
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$prompt" "$default_value" >/dev/tty
  else
    printf '%s: ' "$prompt" >/dev/tty
  fi
  IFS= read -r answer </dev/tty || return 1
  printf '%s' "${answer:-$default_value}"
}

detect_ip() {
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null && return 0
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

if [ -z "$BIND_MODE" ]; then
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "非交互环境请设置 ELEGANZA_BIND=ip 或 ELEGANZA_BIND=domain。" >&2
    exit 2
  fi
  printf '\n请选择面板访问方式（服务将监听 0.0.0.0:%s）：\n' "$PORT" >/dev/tty
  printf '  1) 绑定公网 IP（http://IP:%s）\n' "$PORT" >/dev/tty
  printf '  2) 绑定域名（http://域名:%s，需要 DNS 指向本机）\n' "$PORT" >/dev/tty
  printf '选择 [1/2]: ' >/dev/tty
  read -r BIND_CHOICE </dev/tty || exit 2
  case "$BIND_CHOICE" in
    1) BIND_MODE="ip" ;;
    2) BIND_MODE="domain" ;;
    *) echo "无效选择：$BIND_CHOICE" >&2; exit 2 ;;
  esac
fi

case "$BIND_MODE" in
  ip)
    if [ -z "$PUBLIC_IP" ]; then
      DETECTED_IP="$(detect_ip || true)"
      if [ -r /dev/tty ] && [ -w /dev/tty ]; then
        PUBLIC_IP="$(read_tty "公网 IP" "$DETECTED_IP")" || PUBLIC_IP="$DETECTED_IP"
      else
        PUBLIC_IP="$DETECTED_IP"
      fi
    fi
    if ! printf '%s' "$PUBLIC_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
      echo "公网 IP 格式无效：${PUBLIC_IP:-空}（当前只支持 IPv4；IPv6 请使用域名模式）" >&2
      exit 2
    fi
    PUBLIC_URL="http://${PUBLIC_IP}:${PORT}"
    ;;
  domain)
    if [ -z "$DOMAIN" ]; then
      if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
        echo "域名模式请设置 ELEGANZA_DOMAIN。" >&2
        exit 2
      fi
      DOMAIN="$(read_tty "域名（例如 status.example.com）")" || DOMAIN=""
    fi
    if ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || ! printf '%s' "$DOMAIN" | grep -q '\.'; then
      echo "域名格式无效：${DOMAIN:-空}" >&2
      exit 2
    fi
    PUBLIC_URL="http://${DOMAIN}:${PORT}"
    ;;
  *)
    echo "ELEGANZA_BIND 只能是 ip 或 domain。" >&2
    exit 2
    ;;
esac

echo "==> 访问方式：$PUBLIC_URL（服务监听 ${BIND_HOST}:${PORT}）"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fetch() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$output" --timeout=60 "$url"
  else
    return 1
  fi
}

echo "==> 下载 Eleganza 源码"
SRC_DIR="$TMP_DIR/src"
if command -v git >/dev/null 2>&1; then
  if ! git clone --depth 1 "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1; then
    echo "git clone 失败，尝试下载 tarball…"
    mkdir -p "$SRC_DIR"
    fetch "$TARBALL_URL" "$TMP_DIR/src.tar.gz"
    tar -xzf "$TMP_DIR/src.tar.gz" -C "$TMP_DIR"
    rm -rf "$SRC_DIR"
    mv "$TMP_DIR/eleganza-main" "$SRC_DIR"
  fi
else
  fetch "$TARBALL_URL" "$TMP_DIR/src.tar.gz"
  tar -xzf "$TMP_DIR/src.tar.gz" -C "$TMP_DIR"
  mv "$TMP_DIR/eleganza-main" "$SRC_DIR"
fi

if [ ! -f "$SRC_DIR/server.mjs" ]; then
  echo "源码下载失败，请检查服务器能否访问 GitHub。" >&2
  exit 1
fi

echo "==> 安装到 $INSTALL_DIR"
if [ -d "$INSTALL_DIR" ]; then
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
fi
mkdir -p "$INSTALL_DIR"
# 源码里没有 config.json / data/，因此不会覆盖已有配置和历史数据
cp -a "$SRC_DIR"/. "$INSTALL_DIR"/
rm -rf "$INSTALL_DIR/.git"

if [ ! -f "$INSTALL_DIR/config.json" ]; then
  cp "$INSTALL_DIR/config.example.json" "$INSTALL_DIR/config.json"
  echo "==> 已生成 $INSTALL_DIR/config.json（示例配置）"
fi

# 记录安装时选择的站点地址，探针指令弹窗会直接使用它
"$NODE_BIN" - "$INSTALL_DIR/config.json" "$PUBLIC_URL" <<'NODE'
const fs = require('node:fs');
const [file, publicUrl] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.site = config.site && typeof config.site === 'object' ? config.site : {};
config.site.publicUrl = publicUrl;
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE

mkdir -p "$INSTALL_DIR/data"
if ! id -u eleganza >/dev/null 2>&1; then
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin eleganza
fi
chown -R eleganza:eleganza "$INSTALL_DIR"

echo "==> 写入 systemd 服务"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Eleganza probe panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eleganza
Group=eleganza
WorkingDirectory=$INSTALL_DIR
Environment=ELEGANZA_HOST=$BIND_HOST
Environment=ELEGANZA_PORT=$PORT
Environment=TZ=Asia/Shanghai
ExecStart=$NODE_BIN $INSTALL_DIR/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
if ! systemctl restart "$SERVICE"; then
  echo "服务启动失败，最近日志：" >&2
  journalctl -u "$SERVICE" -n 60 --no-pager >&2 || true
  exit 1
fi

echo "==> 等待面板启动"
OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 1
done

echo
if [ "$OK" -eq 1 ]; then
  echo "安装完成：$PUBLIC_URL"
  echo "本机健康检查：http://127.0.0.1:$PORT/healthz"
else
  echo "服务已启动，但健康检查未通过，请查看："
  echo "  journalctl -u $SERVICE -n 80 --no-pager"
fi

if [ "$BIND_MODE" = "domain" ]; then
  echo
  echo "域名模式提示："
  echo "  1. 确认 $DOMAIN 的 DNS 已指向本机"
  echo "  2. 当前直接访问 http://$DOMAIN:$PORT"
  echo "  3. 正式环境建议用 Caddy / Nginx 反向代理 127.0.0.1:$PORT，并启用 HTTPS"
  echo "     反代后建议在 config.json 设置 site.trustProxy：true"
else
  echo
  echo "如果外部无法访问，请检查云安全组和防火墙是否放行 TCP $PORT："
  echo "  ufw allow $PORT/tcp"
  echo "  firewall-cmd --permanent --add-port=$PORT/tcp && firewall-cmd --reload"
fi

SETUP_TOKEN="$(journalctl -u "$SERVICE" --no-pager -n 120 2>/dev/null | grep -A3 "初始化令牌" | tail -n 3 || true)"
if [ -n "$SETUP_TOKEN" ]; then
  echo
  echo "首次初始化令牌（打开面板后使用）："
  printf '%s\n' "$SETUP_TOKEN"
elif [ -f "$INSTALL_DIR/data/accounts.json" ]; then
  echo
  echo "检测到已有账号数据，直接登录即可。"
else
  echo
  echo "如需命令行创建管理员："
  echo "  cd $INSTALL_DIR && sudo -u eleganza node tools/create-admin.mjs admin"
  echo "创建后请执行：systemctl restart $SERVICE"
fi

echo
echo "配置文件: $INSTALL_DIR/config.json"
echo "查看日志: journalctl -u $SERVICE -f"
echo "安全提示: 面板已对公网监听。请立即用初始化令牌创建管理员；"
echo "          如需禁止匿名访问，把 config.json 的 accounts.required 改为 true 后重启 $SERVICE。"
