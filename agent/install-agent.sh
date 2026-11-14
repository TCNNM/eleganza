#!/usr/bin/env bash
# 一键安装 Polaris agent（systemd）
# 用法:
#   sudo ./install-agent.sh https://status.example.com <AGENT_TOKEN>
#   sudo POLARIS_SERVICES="nginx xray" POLARIS_MOUNTS="/ /var" ./install-agent.sh ...
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
cp "$SCRIPT_DIR/polaris-agent.sh" /usr/local/bin/polaris-agent
chmod 0755 /usr/local/bin/polaris-agent
cp "$SCRIPT_DIR/polaris-agent.service" /etc/systemd/system/polaris-agent.service
chmod 0644 /etc/systemd/system/polaris-agent.service

if [ -f /etc/polaris-agent.env ] && [ "${FORCE:-0}" != "1" ]; then
  echo "已存在 /etc/polaris-agent.env，保留原配置。要覆盖请加 FORCE=1。"
else
  umask 077
  cat > /etc/polaris-agent.env <<EOF
POLARIS_URL=${PANEL_URL}
POLARIS_TOKEN=${TOKEN}
POLARIS_INTERVAL=${POLARIS_INTERVAL:-20}
POLARIS_NODE_NAME=${POLARIS_NODE_NAME:-}
POLARIS_SERVICES="${POLARIS_SERVICES:-}"
POLARIS_MOUNTS="${POLARIS_MOUNTS:-/}"
POLARIS_INSECURE=${POLARIS_INSECURE:-0}
EOF
  chmod 600 /etc/polaris-agent.env
fi

systemctl daemon-reload
systemctl enable --now polaris-agent
sleep 1
systemctl --no-pager --lines=5 status polaris-agent || true
echo
echo "完成。日志: journalctl -u polaris-agent -f"
