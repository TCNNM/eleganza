#!/usr/bin/env bash
# 一键安装 Eleganza agent（systemd）
# 用法:
#   sudo ./install-agent.sh https://status.example.com <AGENT_TOKEN>
#   sudo ELEGANZA_SERVICES="nginx xray" ELEGANZA_MOUNTS="/ /var" ./install-agent.sh ...
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "请用 root 运行（sudo）。" >&2
  exit 1
fi

PANEL_URL="${1:-}"
TOKEN="${2:-}"
if [ -z "$PANEL_URL" ] || [ -z "$TOKEN" ]; then
  echo "用法: sudo $0 https://status.example.com <AGENT_TOKEN>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /usr/local/bin
cp "$SCRIPT_DIR/eleganza-agent.sh" /usr/local/bin/eleganza-agent
chmod 0755 /usr/local/bin/eleganza-agent
cp "$SCRIPT_DIR/eleganza-agent.service" /etc/systemd/system/eleganza-agent.service
chmod 0644 /etc/systemd/system/eleganza-agent.service

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

systemctl daemon-reload
systemctl enable --now eleganza-agent
sleep 1
systemctl --no-pager --lines=5 status eleganza-agent || true
echo
echo "完成。日志: journalctl -u eleganza-agent -f"
