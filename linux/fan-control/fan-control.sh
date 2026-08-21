#!/usr/bin/env bash
set -u

CONFIG_FILE="${FAN_CONTROL_CONFIG:-/etc/default/fan-control}"
if [ -r "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

INTERVAL="${INTERVAL:-1}"
GPU_HWMON_NAMES="${GPU_HWMON_NAMES:-amdgpu radeon}"
BOARD_HWMON_NAMES="${BOARD_HWMON_NAMES:-nct6776 nct6775 nct6779 nct6791 nct6792 nct6793 nct6795 nct6796 nct6797 nct6798 it87}"
GPU_TEMP_INPUT="${GPU_TEMP_INPUT:-auto}"
GPU_MEMORY_TEMP_INPUT="${GPU_MEMORY_TEMP_INPUT:-auto}"
GPU_PWM_NODE="${GPU_PWM_NODE:-pwm1}"
GPU_PWM_ENABLE_NODE="${GPU_PWM_ENABLE_NODE:-pwm1_enable}"
GPU_RPM_NODE="${GPU_RPM_NODE:-fan1_input}"
FAN_PWM_NODE="${FAN_PWM_NODE:-pwm2}"
FAN_PWM_ENABLE_NODE="${FAN_PWM_ENABLE_NODE:-pwm2_enable}"
FAN_RPM_NODE="${FAN_RPM_NODE:-fan2_input}"
MEMORY_TEMP_OFFSET="${MEMORY_TEMP_OFFSET:-10}"

TEMP_1="${TEMP_1:-40}"
TEMP_2="${TEMP_2:-50}"
TEMP_3="${TEMP_3:-60}"
TEMP_4="${TEMP_4:-70}"
TEMP_5="${TEMP_5:-78}"

GPU_PCT_1="${GPU_PCT_1:-45}"
GPU_PCT_2="${GPU_PCT_2:-55}"
GPU_PCT_3="${GPU_PCT_3:-70}"
GPU_PCT_4="${GPU_PCT_4:-85}"
GPU_PCT_5="${GPU_PCT_5:-95}"
GPU_PCT_6="${GPU_PCT_6:-100}"

FAN_PCT_1="${FAN_PCT_1:-50}"
FAN_PCT_2="${FAN_PCT_2:-65}"
FAN_PCT_3="${FAN_PCT_3:-80}"
FAN_PCT_4="${FAN_PCT_4:-90}"
FAN_PCT_5="${FAN_PCT_5:-100}"
FAN_PCT_6="${FAN_PCT_6:-100}"

log() {
  printf '%s fan-control: %s\n' "$(date -Is)" "$*"
}

find_hwmon() {
  local wanted_names="$1"
  local h name
  for h in /sys/class/hwmon/hwmon*; do
    [ -r "$h/name" ] || continue
    name="$(cat "$h/name" 2>/dev/null || true)"
    case " $wanted_names " in
      *" $name "*)
        printf '%s\n' "$h"
        return 0
        ;;
    esac
  done
  return 1
}

find_board_hwmon() {
  local gpu_hwmon="$1"
  local board h
  board="$(find_hwmon "$BOARD_HWMON_NAMES" || true)"
  if [ -n "$board" ]; then
    printf '%s\n' "$board"
    return 0
  fi

  for h in /sys/class/hwmon/hwmon*; do
    if [ "$h" != "$gpu_hwmon" ] && [ -e "$h/$FAN_PWM_NODE" ]; then
      printf '%s\n' "$h"
      return 0
    fi
  done
  return 1
}

resolve_temp_input() {
  local hwmon="$1"
  local configured="$2"
  local kind="$3"
  local label_file label input

  if [ "$configured" != "auto" ]; then
    input="$hwmon/$configured"
    [ -r "$input" ] && printf '%s\n' "$input"
    return
  fi

  for label_file in "$hwmon"/temp*_label; do
    [ -r "$label_file" ] || continue
    label="$(tr '[:upper:]' '[:lower:]' < "$label_file")"
    input="${label_file%_label}_input"
    [ -r "$input" ] || continue

    if [ "$kind" = "primary" ]; then
      case "$label" in
        *junction*|*hotspot*|*edge*)
          printf '%s\n' "$input"
          return
          ;;
      esac
    else
      case "$label" in
        *memory*|*mem*|*vram*|*hbm*)
          printf '%s\n' "$input"
          return
          ;;
      esac
    fi
  done

  if [ "$kind" = "primary" ]; then
    for input in "$hwmon/temp2_input" "$hwmon/temp1_input"; do
      if [ -r "$input" ]; then
        printf '%s\n' "$input"
        return
      fi
    done
  fi
}

read_temp_c() {
  local input="$1"
  local raw
  [ -r "$input" ] || return 1
  raw="$(cat "$input" 2>/dev/null || true)"
  case "$raw" in
    ''|*[!0-9-]*) return 1 ;;
  esac
  printf '%s\n' "$((raw / 1000))"
}

set_pwm_percent() {
  local hwmon="$1"
  local pwm_node="$2"
  local enable_node="$3"
  local percent="$4"
  local raw

  [ -n "$hwmon" ] || return 1
  [ -w "$hwmon/$pwm_node" ] || return 1
  raw="$((percent * 255 / 100))"

  if [ -w "$hwmon/$enable_node" ]; then
    printf '1\n' > "$hwmon/$enable_node"
  fi
  printf '%s\n' "$raw" > "$hwmon/$pwm_node"
}

while true; do
  GPU_HWMON="$(find_hwmon "$GPU_HWMON_NAMES" || true)"
  BOARD_HWMON="$(find_board_hwmon "$GPU_HWMON" || true)"

  if [ -z "$GPU_HWMON" ]; then
    log "GPU hwmon not found; forcing the external fan to full speed"
    set_pwm_percent "$BOARD_HWMON" "$FAN_PWM_NODE" "$FAN_PWM_ENABLE_NODE" 100 || true
    sleep 5
    continue
  fi

  PRIMARY_TEMP_NODE="$(resolve_temp_input "$GPU_HWMON" "$GPU_TEMP_INPUT" primary || true)"
  MEMORY_TEMP_NODE="$(resolve_temp_input "$GPU_HWMON" "$GPU_MEMORY_TEMP_INPUT" memory || true)"
  PRIMARY_TEMP="$(read_temp_c "$PRIMARY_TEMP_NODE" || true)"

  if [ -z "$PRIMARY_TEMP" ]; then
    log "GPU temperature sensor unavailable; forcing controllable fans to full speed"
    set_pwm_percent "$GPU_HWMON" "$GPU_PWM_NODE" "$GPU_PWM_ENABLE_NODE" 100 || true
    set_pwm_percent "$BOARD_HWMON" "$FAN_PWM_NODE" "$FAN_PWM_ENABLE_NODE" 100 || true
    sleep 5
    continue
  fi

  MEMORY_TEMP="$(read_temp_c "$MEMORY_TEMP_NODE" || true)"
  CONTROL_TEMP="$PRIMARY_TEMP"
  if [ -n "$MEMORY_TEMP" ]; then
    MEMORY_CONTROL="$((MEMORY_TEMP + MEMORY_TEMP_OFFSET))"
    if [ "$MEMORY_CONTROL" -gt "$CONTROL_TEMP" ]; then
      CONTROL_TEMP="$MEMORY_CONTROL"
    fi
  fi

  if [ "$CONTROL_TEMP" -lt "$TEMP_1" ]; then
    GPU_PCT="$GPU_PCT_1"; FAN_PCT="$FAN_PCT_1"
  elif [ "$CONTROL_TEMP" -lt "$TEMP_2" ]; then
    GPU_PCT="$GPU_PCT_2"; FAN_PCT="$FAN_PCT_2"
  elif [ "$CONTROL_TEMP" -lt "$TEMP_3" ]; then
    GPU_PCT="$GPU_PCT_3"; FAN_PCT="$FAN_PCT_3"
  elif [ "$CONTROL_TEMP" -lt "$TEMP_4" ]; then
    GPU_PCT="$GPU_PCT_4"; FAN_PCT="$FAN_PCT_4"
  elif [ "$CONTROL_TEMP" -lt "$TEMP_5" ]; then
    GPU_PCT="$GPU_PCT_5"; FAN_PCT="$FAN_PCT_5"
  else
    GPU_PCT="$GPU_PCT_6"; FAN_PCT="$FAN_PCT_6"
  fi

  set_pwm_percent "$GPU_HWMON" "$GPU_PWM_NODE" "$GPU_PWM_ENABLE_NODE" "$GPU_PCT" || true
  set_pwm_percent "$BOARD_HWMON" "$FAN_PWM_NODE" "$FAN_PWM_ENABLE_NODE" "$FAN_PCT" || true

  GPU_PWM_REAL="$(cat "$GPU_HWMON/$GPU_PWM_NODE" 2>/dev/null || echo N/A)"
  GPU_RPM="$(cat "$GPU_HWMON/$GPU_RPM_NODE" 2>/dev/null || echo N/A)"
  FAN_PWM_REAL="$(cat "$BOARD_HWMON/$FAN_PWM_NODE" 2>/dev/null || echo N/A)"
  FAN_RPM="$(cat "$BOARD_HWMON/$FAN_RPM_NODE" 2>/dev/null || echo N/A)"
  MEMORY_DISPLAY="${MEMORY_TEMP:-N/A}"

  log "gpu=${PRIMARY_TEMP}C memory=${MEMORY_DISPLAY}C control=${CONTROL_TEMP}C | GPU=${GPU_PCT}% (${GPU_PWM_REAL}/255) ${GPU_RPM}RPM | Fan=${FAN_PCT}% (${FAN_PWM_REAL}/255) ${FAN_RPM}RPM"
  sleep "$INTERVAL"
done
