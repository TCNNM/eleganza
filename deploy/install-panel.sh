#!/usr/bin/env bash
# Eleganza 面板一键安装（Linux + systemd）
#
# 一行安装：
#   curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/deploy/install-panel.sh \
#     | sudo bash
#
# 安装时会依次询问：
#   1. 绑定域名还是公网 IP
#   2. 是否使用 Caddy 监听
#   3. 是否自动申请 HTTPS 证书
#   4. 公开端口：443 / 自定义端口
#
# 可选环境变量：
#   ELEGANZA_BIND=domain|ip
#   ELEGANZA_DOMAIN=status.example.com
#   ELEGANZA_IP=203.0.113.10
#   ELEGANZA_USE_CADDY=1|0
#   ELEGANZA_AUTO_TLS=1|0
#   ELEGANZA_PORT=443
#   ELEGANZA_DIR=/opt/eleganza
#   ELEGANZA_BACKEND_PORT=8787
#   ELEGANZA_CADDYFILE=/etc/caddy/Caddyfile
#
# 说明：
#   - 域名 + Caddy + 自动证书 = Let's Encrypt
#   - IP   + Caddy + 自动证书 = Caddy 内部 CA（浏览器会提示证书警告）
#   - 不使用 Caddy 时由 Node 直接监听，端口必须 >= 1024，且无法自动提供 HTTPS
set -euo pipefail

REPO_URL="https://github.com/TCNNM/eleganza.git"
TARBALL_URL="https://codeload.github.com/TCNNM/eleganza/tar.gz/refs/heads/main"
INSTALL_DIR="${ELEGANZA_DIR:-/opt/eleganza}"
SERVICE="eleganza"
CADDYFILE_PATH="${ELEGANZA_CADDYFILE:-/etc/caddy/Caddyfile}"

usage() {
  cat <<'USAGE'
用法:
  curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/deploy/install-panel.sh | sudo bash

安装时会询问绑定方式、是否使用 Caddy、是否自动证书以及端口。

非交互式示例:
  # 域名 + Caddy + Let's Encrypt + 443
  ELEGANZA_BIND=domain ELEGANZA_DOMAIN=status.example.com \
  ELEGANZA_USE_CADDY=1 ELEGANZA_AUTO_TLS=1 ELEGANZA_PORT=443 \
  bash install-panel.sh

  # IP + Caddy 内部证书 + 443
  ELEGANZA_BIND=ip ELEGANZA_IP=203.0.113.10 \
  ELEGANZA_USE_CADDY=1 ELEGANZA_AUTO_TLS=1 ELEGANZA_PORT=443 \
  bash install-panel.sh

  # 不使用 Caddy：Node 直接监听 8787
  ELEGANZA_BIND=domain ELEGANZA_DOMAIN=status.example.com \
  ELEGANZA_USE_CADDY=0 ELEGANZA_PORT=8787 \
  bash install-panel.sh

可选环境变量:
  ELEGANZA_BIND=domain|ip
  ELEGANZA_DOMAIN=status.example.com
  ELEGANZA_IP=203.0.113.10
  ELEGANZA_USE_CADDY=1|0
  ELEGANZA_AUTO_TLS=1|0
  ELEGANZA_PORT=443
  ELEGANZA_DIR=/opt/eleganza
  ELEGANZA_BACKEND_PORT=8787
  ELEGANZA_CADDYFILE=/etc/caddy/Caddyfile
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

ask_yes_no() {
  local prompt="$1"
  local default_value="${2:-Y}"
  local answer
  answer="$(read_tty "$prompt" "$default_value")" || return 1
  case "${answer,,}" in
    y|yes|1|true|on) printf '1' ;;
    n|no|0|false|off) printf '0' ;;
    *) return 1 ;;
  esac
}

normalize_bool() {
  case "${1,,}" in
    1|y|yes|true|on) printf '1' ;;
    0|n|no|false|off) printf '0' ;;
    *) return 1 ;;
  esac
}

detect_ip() {
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null && return 0
    curl -6 -fsS --max-time 5 https://api64.ipify.org 2>/dev/null && return 0
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

format_url() {
  local scheme="$1"
  local host="$2"
  local port="$3"
  local display="$host"
  if [[ "$host" == *:* && "$host" != \[* ]]; then
    display="[$host]"
  fi
  if { [ "$scheme" = "https" ] && [ "$port" = "443" ]; } || { [ "$scheme" = "http" ] && [ "$port" = "80" ]; }; then
    printf '%s://%s' "$scheme" "$display"
  else
    printf '%s://%s:%s' "$scheme" "$display" "$port"
  fi
}

# ---------------------------------------------------------------- 访问方式
BIND_KIND="${ELEGANZA_BIND:-}"
DOMAIN="${ELEGANZA_DOMAIN:-}"
PUBLIC_IP="${ELEGANZA_IP:-}"

if [ -z "$BIND_KIND" ] && [ -n "$DOMAIN" ]; then
  BIND_KIND="domain"
fi
if [ -z "$BIND_KIND" ] && [ -n "$PUBLIC_IP" ]; then
  BIND_KIND="ip"
fi

if [ -z "$BIND_KIND" ]; then
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "非交互环境请设置 ELEGANZA_BIND=domain 或 ELEGANZA_BIND=ip。" >&2
    exit 2
  fi
  printf '\n请选择面板绑定方式：\n' >/dev/tty
  printf '  1) 绑定域名（可使用 Let\x27s Encrypt 自动证书）\n' >/dev/tty
  printf '  2) 绑定公网 IP（可使用 Caddy 内部证书）\n' >/dev/tty
  printf '选择 [1/2]: ' >/dev/tty
  read -r BIND_CHOICE </dev/tty || exit 2
  case "$BIND_CHOICE" in
    1) BIND_KIND="domain" ;;
    2) BIND_KIND="ip" ;;
    *) echo "无效选择：$BIND_CHOICE" >&2; exit 2 ;;
  esac
fi

case "$BIND_KIND" in
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
    PUBLIC_HOST="$DOMAIN"
    ;;
  ip)
    PUBLIC_IP="${PUBLIC_IP#[}"; PUBLIC_IP="${PUBLIC_IP%]}"
    if [ -z "$PUBLIC_IP" ]; then
      DETECTED_IP="$(detect_ip || true)"
      if [ -r /dev/tty ] && [ -w /dev/tty ]; then
        PUBLIC_IP="$(read_tty "公网 IP（IPv4 或 IPv6）" "$DETECTED_IP")" || PUBLIC_IP="$DETECTED_IP"
      else
        PUBLIC_IP="$DETECTED_IP"
      fi
    fi
    PUBLIC_IP="${PUBLIC_IP#[}"; PUBLIC_IP="${PUBLIC_IP%]}"
    if ! "$NODE_BIN" -e 'const net=require("node:net");process.exit(net.isIP(process.argv[1])?0:1)' "$PUBLIC_IP"; then
      echo "公网 IP 格式无效：${PUBLIC_IP:-空}" >&2
      exit 2
    fi
    PUBLIC_HOST="$PUBLIC_IP"
    ;;
  *)
    echo "ELEGANZA_BIND 只能是 domain 或 ip。" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------- Caddy
USE_CADDY="${ELEGANZA_USE_CADDY:-}"
if [ -z "$USE_CADDY" ]; then
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    USE_CADDY="$(ask_yes_no "是否使用 Caddy 监听？Caddy 可自动配置 HTTPS 并反代到面板" "Y")" || {
      echo "请输入 y 或 n。" >&2; exit 2;
    }
  else
    USE_CADDY=1
  fi
else
  USE_CADDY="$(normalize_bool "$USE_CADDY")" || { echo "ELEGANZA_USE_CADDY 只能是 1 或 0。" >&2; exit 2; }
fi

# ---------------------------------------------------------------- 证书
AUTO_TLS="${ELEGANZA_AUTO_TLS:-}"
if [ "$USE_CADDY" = "1" ]; then
  if [ -z "$AUTO_TLS" ]; then
    if [ -r /dev/tty ] && [ -w /dev/tty ]; then
      if [ "$BIND_KIND" = "domain" ]; then
        AUTO_TLS="$(ask_yes_no "是否自动申请证书？域名将使用 Let's Encrypt" "Y")" || {
          echo "请输入 y 或 n。" >&2; exit 2;
        }
      else
        AUTO_TLS="$(ask_yes_no "是否启用自动证书？IP 将使用 Caddy 内部 CA（浏览器会提示不受信任）" "Y")" || {
          echo "请输入 y 或 n。" >&2; exit 2;
        }
      fi
    else
      AUTO_TLS=1
    fi
  else
    AUTO_TLS="$(normalize_bool "$AUTO_TLS")" || { echo "ELEGANZA_AUTO_TLS 只能是 1 或 0。" >&2; exit 2; }
  fi
else
  if [ -n "$AUTO_TLS" ] && [ "$(normalize_bool "$AUTO_TLS" 2>/dev/null || printf '0')" = "1" ]; then
    echo "自动证书需要 Caddy；请设置 ELEGANZA_USE_CADDY=1，或关闭自动证书。" >&2
    exit 2
  fi
  AUTO_TLS=0
fi

# ---------------------------------------------------------------- 端口
if [ -z "${ELEGANZA_PORT:-}" ]; then
  if [ "$USE_CADDY" = "1" ]; then
    if [ "$AUTO_TLS" = "1" ]; then DEFAULT_PORT=443; else DEFAULT_PORT=80; fi
  else
    DEFAULT_PORT=8787
  fi
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '\n公开端口：\n' >/dev/tty
    printf '  1) %s（推荐）\n' "$DEFAULT_PORT" >/dev/tty
    printf '  2) 自定义端口\n' >/dev/tty
    printf '选择 [1/2]: ' >/dev/tty
    read -r PORT_CHOICE </dev/tty || exit 2
    case "$PORT_CHOICE" in
      1|"") PUBLIC_PORT="$DEFAULT_PORT" ;;
      2)
        PUBLIC_PORT="$(read_tty "自定义端口（1-65535）")" || PUBLIC_PORT=""
        ;;
      *) echo "无效选择：$PORT_CHOICE" >&2; exit 2 ;;
    esac
  else
    PUBLIC_PORT="$DEFAULT_PORT"
  fi
else
  PUBLIC_PORT="$ELEGANZA_PORT"
fi

if ! printf '%s' "$PUBLIC_PORT" | grep -Eq '^[0-9]+$' || [ "$PUBLIC_PORT" -lt 1 ] || [ "$PUBLIC_PORT" -gt 65535 ]; then
  echo "端口无效：${PUBLIC_PORT:-空}" >&2
  exit 2
fi
if [ "$AUTO_TLS" = "1" ] && [ "$PUBLIC_PORT" = "80" ]; then
  echo "HTTPS 不能使用 80 端口；请选择 443 或 >= 1024 的自定义端口。" >&2
  exit 2
fi
if [ "$AUTO_TLS" = "1" ] && [ "$PUBLIC_PORT" != "443" ] && [ "$PUBLIC_PORT" -lt 1024 ]; then
  echo "自定义 HTTPS 端口请使用 >= 1024；443 由 Caddy 直接监听。" >&2
  exit 2
fi
if [ "$AUTO_TLS" = "0" ] && [ "$PUBLIC_PORT" = "443" ]; then
  echo "443 端口应启用证书；请选择启用证书，或改用 80/8080 等 HTTP 端口。" >&2
  exit 2
fi
if [ "$USE_CADDY" = "0" ] && [ "$PUBLIC_PORT" -lt 1024 ]; then
  echo "不使用 Caddy 时，面板以普通用户运行，无法监听 $PUBLIC_PORT。" >&2
  echo "请改用 8787 等 >= 1024 的端口，或选择使用 Caddy。" >&2
  exit 2
fi

if [ "$AUTO_TLS" = "1" ]; then
  SCHEME="https"
else
  SCHEME="http"
fi
PUBLIC_URL="$(format_url "$SCHEME" "$PUBLIC_HOST" "$PUBLIC_PORT")"

if [ "$USE_CADDY" = "1" ]; then
  NODE_HOST="127.0.0.1"
  NODE_PORT="${ELEGANZA_BACKEND_PORT:-8787}"
  if [ "$NODE_PORT" = "$PUBLIC_PORT" ]; then
    NODE_PORT=$((NODE_PORT + 1))
    [ "$NODE_PORT" -le 65535 ] || { echo "无法为 Caddy 分配后端端口。" >&2; exit 2; }
  fi
  if ! printf '%s' "$NODE_PORT" | grep -Eq '^[0-9]+$' || [ "$NODE_PORT" -lt 1024 ] || [ "$NODE_PORT" -gt 65535 ]; then
    echo "Caddy 后端端口无效：$NODE_PORT（需要 >= 1024）" >&2
    exit 2
  fi
else
  NODE_HOST="0.0.0.0"
  NODE_PORT="$PUBLIC_PORT"
fi

echo "==> 公开地址：$PUBLIC_URL"
echo "==> 面板后端：${NODE_HOST}:${NODE_PORT}"
if [ "$USE_CADDY" = "1" ]; then
  echo "==> Caddy：监听 ${PUBLIC_PORT}，反代 127.0.0.1:${NODE_PORT}"
else
  echo "==> Caddy：不启用，Node 直接监听"
fi
if [ "$AUTO_TLS" = "1" ]; then
  if [ "$BIND_KIND" = "domain" ]; then
    echo "==> 证书：Let's Encrypt（自动）"
  else
    echo "==> 证书：Caddy 内部 CA（浏览器会提示证书警告）"
  fi
else
  echo "==> 证书：不启用（HTTP）"
fi

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi
  echo "==> 未找到 Caddy，尝试自动安装"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq caddy
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y caddy
  elif command -v yum >/dev/null 2>&1; then
    yum install -y caddy
  else
    echo "无法自动安装 Caddy，请先安装 Caddy 后重试。" >&2
    exit 1
  fi
}

if [ "$USE_CADDY" = "1" ]; then
  install_caddy
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fetch() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 --max-time 60 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$output" --timeout=60 --tries=3 "$url"
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

# 记录访问方式和对外地址，供首页「探针指令」使用
"$NODE_BIN" - "$INSTALL_DIR/config.json" "$PUBLIC_URL" "$USE_CADDY" <<'NODE'
const fs = require('node:fs');
const [file, publicUrl, useCaddy] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.site = config.site && typeof config.site === 'object' ? config.site : {};
config.site.publicUrl = publicUrl;
config.site.trustProxy = useCaddy === '1';
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
Environment=ELEGANZA_HOST=$NODE_HOST
Environment=ELEGANZA_PORT=$NODE_PORT
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
  echo "面板服务启动失败，最近日志：" >&2
  journalctl -u "$SERVICE" -n 60 --no-pager >&2 || true
  exit 1
fi

if [ "$USE_CADDY" = "1" ]; then
  echo "==> 配置 Caddy"
  mkdir -p "$(dirname "$CADDYFILE_PATH")"
  CADDY_BACKUP=""
  if [ -f "$CADDYFILE_PATH" ]; then
    CADDY_BACKUP="/root/caddy-Caddyfile-$(date +%Y%m%d-%H%M%S).bak"
    cp "$CADDYFILE_PATH" "$CADDY_BACKUP"
    awk '
      /^# BEGIN ELEGANZA$/ { skip=1; next }
      /^# END ELEGANZA$/ { skip=0; next }
      !skip { print }
    ' "$CADDYFILE_PATH" > "$CADDYFILE_PATH.tmp"
    mv "$CADDYFILE_PATH.tmp" "$CADDYFILE_PATH"
  else
    : > "$CADDYFILE_PATH"
  fi

  printf '\n' >> "$CADDYFILE_PATH"
  SITE_ADDRESS="$(format_url "$SCHEME" "$PUBLIC_HOST" "$PUBLIC_PORT")"
  {
    echo '# BEGIN ELEGANZA'
    echo "$SITE_ADDRESS {"
    echo '    encode gzip'
    echo
    echo '    header {'
    echo '        X-Content-Type-Options nosniff'
    echo '        Referrer-Policy same-origin'
    echo '    }'
    if [ "$BIND_KIND" = "ip" ] && [ "$AUTO_TLS" = "1" ]; then
      echo
      echo '    tls internal'
    fi
    echo
    echo "    reverse_proxy 127.0.0.1:$NODE_PORT {"
    echo '        transport http {'
    echo '            read_timeout 30s'
    echo '        }'
    echo '    }'
    echo '}'
    if [ "$BIND_KIND" = "domain" ] && [ "$AUTO_TLS" = "1" ] && [ "$PUBLIC_PORT" != "443" ]; then
      echo
      echo "http://$DOMAIN {"
      echo "    redir $PUBLIC_URL{uri} permanent"
      echo '}'
    fi
    echo '# END ELEGANZA'
  } >> "$CADDYFILE_PATH"

  restore_caddy() {
    if [ -n "${CADDY_BACKUP:-}" ] && [ -f "$CADDY_BACKUP" ]; then
      cp "$CADDY_BACKUP" "$CADDYFILE_PATH"
      systemctl reload caddy >/dev/null 2>&1 || true
    fi
  }

  if ! caddy fmt --overwrite "$CADDYFILE_PATH"; then
    echo "Caddyfile 格式化失败，已恢复原配置。" >&2
    restore_caddy
    exit 1
  fi
  if ! caddy validate --adapter caddyfile --config "$CADDYFILE_PATH"; then
    echo "Caddyfile 校验失败，已恢复原配置。" >&2
    restore_caddy
    exit 1
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  if ! systemctl restart caddy; then
    echo "Caddy 启动失败，最近日志：" >&2
    journalctl -u caddy -n 60 --no-pager >&2 || true
    restore_caddy
    exit 1
  fi
fi

echo "==> 等待面板启动"
OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:$NODE_PORT/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 1
done

echo
if [ "$OK" -eq 1 ]; then
  echo "安装完成：$PUBLIC_URL"
  echo "本机健康检查：http://127.0.0.1:$NODE_PORT/healthz"
else
  echo "服务已启动，但健康检查未通过，请查看："
  echo "  journalctl -u $SERVICE -n 80 --no-pager"
fi

if [ "$USE_CADDY" = "1" ]; then
  echo
  echo "Caddy 监听：${PUBLIC_PORT}"
  echo "Caddy 反代：127.0.0.1:${NODE_PORT}"
  if [ "$AUTO_TLS" = "1" ]; then
    if [ "$BIND_KIND" = "domain" ]; then
      echo "证书：Let's Encrypt（Caddy 自动续期）"
      echo "请确认 80 和 ${PUBLIC_PORT} 已放行，并等待 Caddy 完成证书申请。"
      echo "查看日志：journalctl -u caddy -f"
    else
      echo "证书：Caddy 内部 CA（自动续期）"
      echo "浏览器会提示证书不受信任；Agent 安装命令会自动带上 ELEGANZA_INSECURE=1。"
    fi
  else
    echo "证书：未启用（HTTP），如需 HTTPS 请重新运行并启用自动证书。"
  fi
else
  echo
  echo "Node 直接监听 ${NODE_HOST}:${NODE_PORT}，没有自动 HTTPS。"
  echo "如果外部无法访问，请检查云安全组和防火墙是否放行 TCP ${PUBLIC_PORT}。"
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
if [ -n "${CADDY_BACKUP:-}" ]; then
  echo "Caddyfile 备份: $CADDY_BACKUP"
fi
echo "安全提示: 请立即用初始化令牌创建管理员；如需禁止匿名访问，把 config.json 的 accounts.required 改为 true 后重启 $SERVICE。"
