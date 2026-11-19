#!/usr/bin/env bash
# Eleganza agent 一键安装（systemd / OpenRC）
#
# 本地安装（脚本同目录已有 eleganza-agent.sh / .service）：
#   read -r -s -p 'Agent Token: ' ELEGANZA_TOKEN; echo
#   sudo env ELEGANZA_TOKEN="$ELEGANZA_TOKEN" ELEGANZA_SERVICES="nginx xray" \
#     ./install-agent.sh https://panel.example.com
#
# GitHub 一行安装（脚本会自动下载其余文件）：
#   read -r -s -p 'Agent Token: ' ELEGANZA_TOKEN; echo
#   curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/agent/install-agent.sh \
#     | sudo env ELEGANZA_TOKEN="$ELEGANZA_TOKEN" ELEGANZA_SERVICES="nginx xray" \
#       ELEGANZA_MOUNTS="/ /var" bash -s -- https://panel.example.com
#
# 也可以把 Token 作为第二个参数传入，但会留在 shell 历史里，不推荐。
# 可选环境变量：ELEGANZA_TOKEN / ELEGANZA_SERVICES / ELEGANZA_MOUNTS /
#               ELEGANZA_INTERVAL / ELEGANZA_NODE_NAME / ELEGANZA_INSECURE /
#               ELEGANZA_AGENT_BASE / FORCE
set -euo pipefail

PANEL_URL="${1:-${ELEGANZA_PANEL_URL:-}}"
TOKEN="${2:-${ELEGANZA_TOKEN:-}}"
RAW_BASE="${ELEGANZA_AGENT_BASE:-https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/agent}"

usage() {
  cat <<'USAGE'
用法:
  read -r -s -p 'Agent Token: ' ELEGANZA_TOKEN; echo
  sudo env ELEGANZA_TOKEN="$ELEGANZA_TOKEN" ./install-agent.sh https://panel.example.com

GitHub 一行安装:
  read -r -s -p 'Agent Token: ' ELEGANZA_TOKEN; echo
  curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/agent/install-agent.sh \
    | sudo env ELEGANZA_TOKEN="$ELEGANZA_TOKEN" ELEGANZA_SERVICES="nginx xray" \
      ELEGANZA_MOUNTS="/ /var" bash -s -- https://panel.example.com

Alpine Linux（root）:
  apk add --no-cache bash curl ca-certificates
  curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/agent/install-agent.sh \
    | env ELEGANZA_TOKEN="$ELEGANZA_TOKEN" bash -s -- https://panel.example.com
USAGE
}

if [ -z "$PANEL_URL" ] || [ -z "$TOKEN" ]; then
  usage >&2
  exit 2
fi
case "$TOKEN" in
  '<'*'>'|请替换*|CHANGE_ME|change_me|REPLACE_ME|replace_me)
    echo "检测到占位符 $TOKEN，请替换成真实的 agentKey。" >&2
    exit 2
    ;;
esac

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "请用 root 运行（sudo）。" >&2
  exit 1
fi

INIT_SYSTEM=""
if command -v systemctl >/dev/null 2>&1; then
  INIT_SYSTEM="systemd"
elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
  INIT_SYSTEM="openrc"
else
  echo "当前系统没有 systemd 或 OpenRC，无法注册常驻服务。" >&2
  echo "请参考 README 的「手动运行 / 没有 systemd」一节。" >&2
  exit 1
fi
SERVICE_FILE="eleganza-agent.service"
[ "$INIT_SYSTEM" = "openrc" ] && SERVICE_FILE="eleganza-agent.openrc"

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

fetch_file() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 --max-time 30 "$url" -o "$output"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output" --timeout=30 --tries=3 "$url"
    return
  fi
  echo "需要 curl 或 wget 才能下载 Agent 文件。" >&2
  return 1
}

normalize_lf() {
  local file="$1"
  if LC_ALL=C grep -q $'\r' "$file" 2>/dev/null; then
    tr -d '\r' < "$file" > "$file.lf"
    mv "$file.lf" "$file"
  fi
}

invalid_file() {
  local file="$1"
  echo "下载的 $(basename "$file") 内容不合法。" >&2
  echo "  大小: $(wc -c < "$file" 2>/dev/null || echo 0) 字节" >&2
  echo "  首行: $(sed -n '1p' "$file" 2>/dev/null | cut -c1-120)" >&2
  echo "可能是网络代理/镜像返回了 HTML 页面。请检查服务器访问 GitHub 的网络后重试。" >&2
  exit 1
}

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] \
  && [ -s "$SCRIPT_DIR/eleganza-agent.sh" ] \
  && [ -s "$SCRIPT_DIR/$SERVICE_FILE" ]; then
  SRC_DIR="$SCRIPT_DIR"
else
  TMP_DIR="$(mktemp -d)"
  SRC_DIR="$TMP_DIR"
  echo "下载 Eleganza Agent 文件: $RAW_BASE ($INIT_SYSTEM)"
  fetch_file "$RAW_BASE/eleganza-agent.sh" "$SRC_DIR/eleganza-agent.sh"
  fetch_file "$RAW_BASE/$SERVICE_FILE" "$SRC_DIR/$SERVICE_FILE"
fi

if [ ! -s "$SRC_DIR/eleganza-agent.sh" ] || [ ! -s "$SRC_DIR/$SERVICE_FILE" ]; then
  echo "Agent 文件下载失败，请检查网络或 ELEGANZA_AGENT_BASE。" >&2
  exit 1
fi

normalize_lf "$SRC_DIR/eleganza-agent.sh"
normalize_lf "$SRC_DIR/$SERVICE_FILE"

SHEBANG="$(sed -n '1p' "$SRC_DIR/eleganza-agent.sh" | tr -d '\r')"
SHEBANG="${SHEBANG#$'\xEF\xBB\xBF'}"
if [ "$SHEBANG" != "#!/usr/bin/env bash" ] && [ "$SHEBANG" != "#!/bin/bash" ]; then
  invalid_file "$SRC_DIR/eleganza-agent.sh"
fi
if [ "$INIT_SYSTEM" = "systemd" ]; then
  if ! grep -q '^\[Unit\]' "$SRC_DIR/$SERVICE_FILE"; then
    invalid_file "$SRC_DIR/$SERVICE_FILE"
  fi
else
  if ! grep -q '^command=' "$SRC_DIR/$SERVICE_FILE" || ! grep -q 'openrc-run' "$SRC_DIR/$SERVICE_FILE"; then
    invalid_file "$SRC_DIR/$SERVICE_FILE"
  fi
fi

mkdir -p /usr/local/bin
cp "$SRC_DIR/eleganza-agent.sh" /usr/local/bin/eleganza-agent
chmod 0755 /usr/local/bin/eleganza-agent
if [ "$INIT_SYSTEM" = "systemd" ]; then
  cp "$SRC_DIR/$SERVICE_FILE" /etc/systemd/system/eleganza-agent.service
  chmod 0644 /etc/systemd/system/eleganza-agent.service
else
  cp "$SRC_DIR/$SERVICE_FILE" /etc/init.d/eleganza-agent
  chmod 0755 /etc/init.d/eleganza-agent
fi

if [ -f /etc/eleganza-agent.env ] && [ "${FORCE:-0}" != "1" ]; then
  echo "已存在 /etc/eleganza-agent.env，保留原配置。要覆盖请加 FORCE=1。"
else
  umask 077
  cat > /etc/eleganza-agent.env <<EOF
ELEGANZA_URL=${PANEL_URL}
ELEGANZA_TOKEN=${TOKEN}
ELEGANZA_INTERVAL=${ELEGANZA_INTERVAL:-20}
ELEGANZA_NODE_NAME=${ELEGANZA_NODE_NAME:-}
ELEGANZA_SERVICES="${ELEGANZA_SERVICES:-}"
ELEGANZA_MOUNTS="${ELEGANZA_MOUNTS:-/}"
ELEGANZA_INSECURE=${ELEGANZA_INSECURE:-0}
EOF
  chmod 600 /etc/eleganza-agent.env
fi

if [ "$INIT_SYSTEM" = "systemd" ]; then
  systemctl daemon-reload
  systemctl enable eleganza-agent >/dev/null 2>&1 || true
  systemctl restart eleganza-agent
  sleep 2

  echo
  echo "安装完成（systemd）。"
  systemctl --no-pager --lines=8 status eleganza-agent || true
  echo
  echo "实时日志: journalctl -u eleganza-agent -f"
else
  rc-update add eleganza-agent default >/dev/null 2>&1 || true
  rc-service eleganza-agent restart >/dev/null 2>&1 || rc-service eleganza-agent start
  sleep 2

  echo
  echo "安装完成（OpenRC）。"
  rc-service eleganza-agent status || true
  echo
  echo "查看状态: rc-service eleganza-agent status"
  echo "手动测试: /usr/local/bin/eleganza-agent --once"
fi
echo "配置文件: /etc/eleganza-agent.env"
