#!/usr/bin/env bash
# Eleganza 面板一键安装（Linux + systemd）
#
# 一行安装：
#   curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/main/deploy/install-panel.sh \
#     | sudo bash
#
# 可选环境变量：
#   ELEGANZA_DIR=/opt/eleganza   安装目录
#   ELEGANZA_PORT=8787           监听端口（只绑定 127.0.0.1）
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

usage() {
  cat <<'USAGE'
用法:
  curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/main/deploy/install-panel.sh | sudo bash

可选环境变量:
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
Environment=ELEGANZA_HOST=127.0.0.1
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
  echo "安装完成：http://127.0.0.1:$PORT"
else
  echo "服务已启动，但健康检查未通过，请查看："
  echo "  journalctl -u $SERVICE -n 80 --no-pager"
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
echo "公网访问请用 Caddy / Nginx 反向代理，并在 config.json 设置 site.trustProxy: true"
