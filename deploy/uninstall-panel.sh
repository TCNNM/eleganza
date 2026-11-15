#!/usr/bin/env bash
# Eleganza 面板快捷卸载（Linux + systemd）
#
# 默认行为：
#   停止并删除 eleganza.service
#   删除 /opt/eleganza
#   删除前把 config.json 和 data/ 备份到 /root/eleganza-backup-<时间>.tar.gz
#
# 一行卸载：
#   curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/deploy/uninstall-panel.sh \
#     | sudo bash
#
# 无交互卸载：
#   curl ... | sudo env ELEGANZA_UNINSTALL_YES=1 bash
#
# 彻底删除（不备份配置和历史数据）：
#   curl ... | sudo env ELEGANZA_UNINSTALL_YES=1 ELEGANZA_UNINSTALL_PURGE=1 bash
set -euo pipefail

SERVICE="eleganza"
INSTALL_DIR="${ELEGANZA_DIR:-/opt/eleganza}"
CADDYFILE_PATH="${ELEGANZA_CADDYFILE:-/etc/caddy/Caddyfile}"
ASSUME_YES="${ELEGANZA_UNINSTALL_YES:-0}"
PURGE="${ELEGANZA_UNINSTALL_PURGE:-0}"

usage() {
  cat <<'USAGE'
用法:
  curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/refs/heads/main/deploy/uninstall-panel.sh | sudo bash

可选环境变量:
  ELEGANZA_DIR=/opt/eleganza       安装目录
  ELEGANZA_CADDYFILE=/etc/caddy/Caddyfile
  ELEGANZA_UNINSTALL_YES=1         跳过确认
  ELEGANZA_UNINSTALL_PURGE=1       不备份，直接删除配置和数据
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

if [ -n "$INSTALL_DIR" ] && { [ "$INSTALL_DIR" = "/" ] || [ "$INSTALL_DIR" = "/opt" ] || [ "$INSTALL_DIR" = "/usr" ] || [ "$INSTALL_DIR" = "/etc" ]; }; then
  echo "拒绝删除不安全的安装目录：$INSTALL_DIR" >&2
  exit 1
fi

if [ -d "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/server.mjs" ] && [ ! -f "$INSTALL_DIR/package.json" ]; then
  echo "$INSTALL_DIR 不像 Eleganza 安装目录，已停止。" >&2
  exit 1
fi

if [ "$ASSUME_YES" != "1" ]; then
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "非交互环境请设置 ELEGANZA_UNINSTALL_YES=1。" >&2
    exit 2
  fi
  printf '\n将停止并删除 Eleganza 服务（systemd: %s），并删除 %s。\n' "$SERVICE" "$INSTALL_DIR" >/dev/tty
  if [ "$PURGE" = "1" ]; then
    printf '⚠ 彻底模式：配置和历史数据将不会备份，直接删除。\n' >/dev/tty
  else
    printf '卸载前会把 config.json 和 data/ 备份到 /root/eleganza-backup-*.tar.gz。\n' >/dev/tty
  fi
  printf '确认继续？[y/N]: ' >/dev/tty
  read -r ANSWER </dev/tty || exit 2
  case "$ANSWER" in
    y|Y|yes|YES) ;;
    *) echo "已取消。"; exit 0 ;;
  esac
fi

HAVE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
fi

if [ "$HAVE_SYSTEMD" = "1" ]; then
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  systemctl disable "$SERVICE" >/dev/null 2>&1 || true
fi

if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  rm -f "/etc/systemd/system/$SERVICE.service"
  echo "已删除 /etc/systemd/system/$SERVICE.service"
fi

if [ "$HAVE_SYSTEMD" = "1" ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
fi

if [ -f "$CADDYFILE_PATH" ] && grep -q '^# BEGIN ELEGANZA$' "$CADDYFILE_PATH"; then
  CADDY_BACKUP="/root/caddy-Caddyfile-$(date +%Y%m%d-%H%M%S).bak"
  cp "$CADDYFILE_PATH" "$CADDY_BACKUP"
  awk '
    /^# BEGIN ELEGANZA$/ { skip=1; next }
    /^# END ELEGANZA$/ { skip=0; next }
    !skip { print }
  ' "$CADDYFILE_PATH" > "$CADDYFILE_PATH.tmp"
  mv "$CADDYFILE_PATH.tmp" "$CADDYFILE_PATH"
  if command -v caddy >/dev/null 2>&1; then
    caddy fmt --overwrite "$CADDYFILE_PATH" >/dev/null 2>&1 || true
    if [ "$HAVE_SYSTEMD" = "1" ] && systemctl is-active caddy >/dev/null 2>&1; then
      systemctl reload caddy >/dev/null 2>&1 || true
    fi
  fi
  echo "已移除 Eleganza 的 Caddy 配置块"
  echo "Caddyfile 备份：$CADDY_BACKUP"
fi

BACKUP=""
if [ -d "$INSTALL_DIR" ]; then
  if [ "$PURGE" != "1" ]; then
    PATHS=()
    [ -f "$INSTALL_DIR/config.json" ] && PATHS+=("config.json")
    [ -d "$INSTALL_DIR/data" ] && PATHS+=("data")
    if [ "${#PATHS[@]}" -gt 0 ]; then
      mkdir -p /root
      BACKUP="/root/eleganza-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
      if ! tar -czf "$BACKUP" -C "$INSTALL_DIR" "${PATHS[@]}"; then
        echo "备份失败，已停止卸载，未删除 $INSTALL_DIR。" >&2
        rm -f "$BACKUP"
        exit 1
      fi
      chmod 600 "$BACKUP"
      echo "配置和历史数据已备份到：$BACKUP"
    fi
  fi

  rm -rf -- "$INSTALL_DIR"
  echo "已删除 $INSTALL_DIR"
else
  echo "未找到安装目录 $INSTALL_DIR（可能已经卸载）。"
fi

if [ "$PURGE" = "1" ] && id -u eleganza >/dev/null 2>&1; then
  userdel eleganza >/dev/null 2>&1 || true
  echo "已尝试删除系统用户 eleganza"
fi

echo
echo "Eleganza 面板卸载完成。"
if [ -n "$BACKUP" ]; then
  echo "备份文件：$BACKUP"
fi
