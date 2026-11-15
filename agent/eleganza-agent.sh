#!/usr/bin/env bash
# Eleganza agent — reads local Linux metrics and pushes them to a Eleganza panel.
# No dependencies beyond bash, awk, df, uname and curl (or wget).
#
# Usage:
#   ELEGANZA_URL=https://status.example.com ELEGANZA_TOKEN=xxxx eleganza-agent --once
#   eleganza-agent                 # loop, reading /etc/eleganza-agent.env by default
#
# Environment:
#   ELEGANZA_URL             panel base URL (required)
#   ELEGANZA_TOKEN           agentKey from config.json (required)
#   ELEGANZA_INTERVAL        seconds between reports, default 20
#   ELEGANZA_NODE_NAME       hostname override
#   ELEGANZA_SERVICES        space separated units, e.g. "nginx xray"
#   ELEGANZA_MOUNTS          space separated mount points, default "/"
#   ELEGANZA_INSECURE        "1" to skip TLS verification (self-signed only)
#   ELEGANZA_AGENT_ENV       env file path, default /etc/eleganza-agent.env

set -uo pipefail

VERSION="1.2.0"
ENV_FILE="${ELEGANZA_AGENT_ENV:-/etc/eleganza-agent.env}"
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

MODE="loop"
for arg in "$@"; do
  case "$arg" in
    --once) MODE="once" ;;
    --print) MODE="print" ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

ELEGANZA_URL="${ELEGANZA_URL:-}"
ELEGANZA_TOKEN="${ELEGANZA_TOKEN:-}"
INTERVAL="${ELEGANZA_INTERVAL:-20}"
MOUNTS="${ELEGANZA_MOUNTS:-/}"
SERVICES="${ELEGANZA_SERVICES:-}"
INSECURE="${ELEGANZA_INSECURE:-0}"

case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=20 ;;
esac
[ "$INTERVAL" -lt 5 ] && INTERVAL=5

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

read_cpu_snapshot() {
  awk '/^cpu /{print $2, $3, $4, $5, $6, $7, $8}' /proc/stat 2>/dev/null
}

collect_cpu() {
  local first second usage
  first="$(read_cpu_snapshot)"
  sleep 1
  second="$(read_cpu_snapshot)"
  usage="$(awk -v a="$first" -v b="$second" 'BEGIN {
    n = split(a, x, " ");
    if (n < 4 || split(b, y, " ") < 4) { print "0"; exit }
    total = 0; idle = 0;
    for (i = 1; i <= n; i++) { delta = y[i] - x[i]; if (delta < 0) delta = 0; total += delta; if (i == 4 || i == 5) idle += delta }
    if (total <= 0) { print "0"; exit }
    printf "%.1f", (total - idle) * 100 / total
  }')"
  printf '%s' "${usage:-0}"
}

collect_disks() {
  local mount line total_kb used_kb cap percent output sep
  output=""
  sep=""
  for mount in $MOUNTS; do
    [ -d "$mount" ] || continue
    line="$(df -P -k "$mount" 2>/dev/null | awk 'NR==2 {print $2"\t"$3"\t"$5"\t"$6}')"
    [ -n "$line" ] || continue
    IFS=$'\t' read -r total_kb used_kb cap mount_point <<< "$line"
    percent="${cap%\%}"
    case "$percent" in ''|*[!0-9]*) percent=0 ;; esac
    output="${output}${sep}{\"mount\":\"$(json_escape "$mount_point")\",\"total\":$((total_kb * 1024)),\"used\":$((used_kb * 1024)),\"percent\":$percent}"
    sep=","
  done
  printf '%s' "$output"
}

collect_services() {
  local service status output sep
  output=""
  sep=""
  [ -n "$SERVICES" ] || { printf '%s' ""; return; }
  for service in $SERVICES; do
    status="false"
    if command -v systemctl >/dev/null 2>&1; then
      [ "$(systemctl is-active "$service" 2>/dev/null || true)" = "active" ] && status="true"
    elif command -v rc-service >/dev/null 2>&1; then
      rc-service "$service" status >/dev/null 2>&1 && status="true"
    elif command -v service >/dev/null 2>&1; then
      service "$service" status >/dev/null 2>&1 && status="true"
    fi
    output="${output}${sep}{\"name\":\"$(json_escape "$service")\",\"active\":$status}"
    sep=","
  done
  printf '%s' "$output"
}

build_payload() {
  local host platform kernel uptime load cores cpu_model cpu_usage
  local load1 load5 load15 mem_total_kb mem_avail_kb mem_used disks services rx tx net_line
  local payload

  host="${ELEGANZA_NODE_NAME:-$(hostname 2>/dev/null || echo unknown)}"
  kernel="$(uname -r 2>/dev/null || echo unknown)"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    platform="$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}")"
  else
    platform="$(uname -s 2>/dev/null || echo unknown)"
  fi

  uptime=0
  if [ -r /proc/uptime ]; then
    read -r uptime _ < /proc/uptime
    uptime="${uptime%.*}"
  fi
  case "$uptime" in ''|*[!0-9]*) uptime=0 ;; esac

  load="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo "0.00 0.00 0.00")"
  set -- $load
  load1="${1:-0.00}"; load5="${2:-0.00}"; load15="${3:-0.00}"

  cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  cpu_model="$(awk -F': ' '/model name|Hardware|Processor/{print $2; exit}' /proc/cpuinfo 2>/dev/null | sed 's/^[[:space:]]*//')"
  [ -n "$cpu_model" ] || cpu_model="unknown"
  cpu_usage="$(collect_cpu)"

  mem_total_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  mem_avail_kb="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || awk '/^MemFree:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  case "$mem_total_kb" in ''|*[!0-9]*) mem_total_kb=0 ;; esac
  case "$mem_avail_kb" in ''|*[!0-9]*) mem_avail_kb=0 ;; esac
  [ "$mem_avail_kb" -gt "$mem_total_kb" ] && mem_avail_kb=0
  mem_used=$(( (mem_total_kb - mem_avail_kb) * 1024 ))

  disks="$(collect_disks)"
  services="$(collect_services)"

  net_line="$(awk -F'[: ]+' 'NR>2 && $1!="lo" {rx+=$2; tx+=$10} END{printf "%d %d", rx+0, tx+0}' /proc/net/dev 2>/dev/null || echo "0 0")"
  set -- $net_line
  rx="${1:-0}"; tx="${2:-0}"

  payload="$(cat <<EOF
{"hostname":"$(json_escape "$host")","platform":"$(json_escape "$platform")","kernel":"$(json_escape "$kernel")","agentVersion":"$VERSION","uptimeSeconds":$uptime,"cpu":{"usage":$cpu_usage,"cores":$cores,"model":"$(json_escape "$cpu_model")"},"memory":{"total":$((mem_total_kb * 1024)),"used":$mem_used},"disks":[$disks],"net":{"rxBytes":$rx,"txBytes":$tx},"load":[$load1,$load5,$load15],"services":[$services]}
EOF
)"
  printf '%s' "$payload"
}

post_report() {
  local payload="$1" output status
  if command -v curl >/dev/null 2>&1; then
    if [ "$INSECURE" = "1" ]; then
      output="$(curl -fsS -k --max-time 20 -X POST "${ELEGANZA_URL%/}/api/agent/report" \
        -H "Authorization: Bearer ${ELEGANZA_TOKEN}" \
        -H "Content-Type: application/json" \
        --data-binary "$payload" 2>&1)"
      status=$?
    else
      output="$(curl -fsS --max-time 20 -X POST "${ELEGANZA_URL%/}/api/agent/report" \
        -H "Authorization: Bearer ${ELEGANZA_TOKEN}" \
        -H "Content-Type: application/json" \
        --data-binary "$payload" 2>&1)"
      status=$?
    fi
    if [ "$status" -ne 0 ]; then
      printf '%s\n' "$output" >&2
      return 1
    fi
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    output="$(wget -q -O - --timeout=20 --header="Authorization: Bearer ${ELEGANZA_TOKEN}" \
      --header="Content-Type: application/json" --post-data="$payload" \
      "${ELEGANZA_URL%/}/api/agent/report" 2>&1)"
    status=$?
    if [ "$status" -ne 0 ]; then
      printf '%s\n' "$output" >&2
      return 1
    fi
    return 0
  fi
  echo "需要 curl 或 wget" >&2
  return 2
}

run_once() {
  local payload attempt
  payload="$(build_payload)"
  if [ -z "$payload" ]; then
    log "采集失败：无法构造上报内容"
    return 1
  fi
  if [ "$MODE" = "print" ]; then
    printf '%s\n' "$payload"
    return 0
  fi
  for attempt in 1 2 3; do
    if post_report "$payload"; then
      log "上报成功"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      log "上报失败（第 ${attempt} 次），$((attempt * 2)) 秒后重试"
      sleep $((attempt * 2))
    else
      log "上报失败（第 3 次），本轮放弃"
    fi
  done
  return 1
}

if [ -z "$ELEGANZA_URL" ] || [ -z "$ELEGANZA_TOKEN" ]; then
  echo "缺少 ELEGANZA_URL 或 ELEGANZA_TOKEN。参考 agent/eleganza-agent.env.example。" >&2
  echo "用法: ELEGANZA_URL=https://panel.example.com ELEGANZA_TOKEN=xxx $0 --once" >&2
  exit 2
fi

if [ "$MODE" != "loop" ]; then
  run_once
  exit $?
fi

trap 'log "收到终止信号，退出"; exit 0' TERM INT
log "Eleganza agent v${VERSION} 启动：${ELEGANZA_URL%/} · 间隔 ${INTERVAL}s"
while true; do
  run_once || true
  sleep "$INTERVAL"
done
