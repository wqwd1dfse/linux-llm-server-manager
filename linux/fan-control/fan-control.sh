#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE="${FAN_CONTROL_CONFIG:-/etc/default/fan-control}"
RESTORE_ONLY=0
VALIDATE_CONFIG_ONLY=0
if [ "${1:-}" = "--restore-auto" ]; then
  RESTORE_ONLY=1
elif [ "${1:-}" = "--validate-config" ]; then
  VALIDATE_CONFIG_ONLY=1
fi

configuration_file_is_secure() {
  local config_file="$1"
  local expected_uid=0
  local actual_uid mode

  if [ "${FAN_CONTROL_ALLOW_NON_ROOT_TESTING:-0}" = "1" ]; then
    expected_uid="$(id -u)" || return 1
  fi

  [ -f "$config_file" ] && [ ! -L "$config_file" ] || return 1
  actual_uid="$(stat -c '%u' -- "$config_file" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' -- "$config_file" 2>/dev/null)" || return 1
  [ "$actual_uid" = "$expected_uid" ] || return 1
  case "$mode" in
    *[2367][0-7]|*[0-7][2367]) return 1 ;;
  esac
}

configuration_key_is_supported() {
  case "$1" in
    INTERVAL|GPU_HWMON_NAMES|BOARD_HWMON_NAMES|GPU_TEMP_INPUT|GPU_MEMORY_TEMP_INPUT|\
    GPU_PWM_NODE|GPU_PWM_ENABLE_NODE|GPU_RPM_NODE|FAN_PWM_NODE|FAN_PWM_ENABLE_NODE|\
    FAN_RPM_NODE|GPU_AUTO_ENABLE_VALUE|BOARD_AUTO_ENABLE_VALUE|BOARD_AUTO_ENABLE_NODES|\
    MEMORY_TEMP_OFFSET|TEMP_[1-5]|GPU_PCT_[1-6]|FAN_PCT_[1-6]) return 0 ;;
    *) return 1 ;;
  esac
}

unsigned_integer_in_range() {
  local value="$1"
  local minimum="$2"
  local maximum="$3"
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$value" -ge "$minimum" ] && [ "$value" -le "$maximum" ]
}

configuration_value_is_supported() {
  local key="$1"
  local value="$2"
  local magnitude item
  local -a items=()

  [ -n "$value" ] || return 0
  case "$key" in
    INTERVAL) unsigned_integer_in_range "$value" 1 60 ;;
    GPU_AUTO_ENABLE_VALUE|BOARD_AUTO_ENABLE_VALUE) unsigned_integer_in_range "$value" 0 255 ;;
    TEMP_[1-5]) unsigned_integer_in_range "$value" 0 200 ;;
    GPU_PCT_[1-6]|FAN_PCT_[1-6]) unsigned_integer_in_range "$value" 0 100 ;;
    MEMORY_TEMP_OFFSET)
      magnitude="${value#-}"
      unsigned_integer_in_range "$magnitude" 0 100
      ;;
    GPU_TEMP_INPUT|GPU_MEMORY_TEMP_INPUT)
      [ "$value" = "auto" ] || case "$value" in *[!a-zA-Z0-9_]*) false ;; *) true ;; esac
      ;;
    GPU_PWM_NODE|GPU_PWM_ENABLE_NODE|GPU_RPM_NODE|FAN_PWM_NODE|FAN_PWM_ENABLE_NODE|FAN_RPM_NODE)
      case "$value" in *[!a-zA-Z0-9_]*) return 1 ;; esac
      ;;
    GPU_HWMON_NAMES|BOARD_HWMON_NAMES)
      read -r -a items <<< "$value" || return 1
      [ "${#items[@]}" -gt 0 ] || return 1
      for item in "${items[@]}"; do
        case "$item" in *[!a-zA-Z0-9_-]*) return 1 ;; esac
      done
      ;;
    BOARD_AUTO_ENABLE_NODES)
      read -r -a items <<< "$value" || return 1
      [ "${#items[@]}" -gt 0 ] || return 1
      for item in "${items[@]}"; do
        case "$item" in
          *[!a-zA-Z0-9_]*|*_enable_enable) return 1 ;;
          *_enable) ;;
          *) return 1 ;;
        esac
      done
      ;;
    *) return 1 ;;
  esac
}

configuration_curve_is_safe() {
  local t1="$1" t2="$2" t3="$3" t4="$4" t5="$5"
  local g1="$6" g2="$7" g3="$8" g4="$9" g5="${10}" g6="${11}"
  local f1="${12}" f2="${13}" f3="${14}" f4="${15}" f5="${16}" f6="${17}"
  local value

  for value in "$t1" "$t2" "$t3" "$t4" "$t5"; do
    unsigned_integer_in_range "$value" 0 200 || return 1
  done
  for value in "$g1" "$g2" "$g3" "$g4" "$g5" "$g6" \
    "$f1" "$f2" "$f3" "$f4" "$f5" "$f6"; do
    unsigned_integer_in_range "$value" 0 100 || return 1
  done

  [ "$t1" -lt "$t2" ] && [ "$t2" -lt "$t3" ] &&
    [ "$t3" -lt "$t4" ] && [ "$t4" -lt "$t5" ] || return 1
  [ "$g1" -le "$g2" ] && [ "$g2" -le "$g3" ] &&
    [ "$g3" -le "$g4" ] && [ "$g4" -le "$g5" ] &&
    [ "$g5" -le "$g6" ] && [ "$g6" -eq 100 ] || return 1
  [ "$f1" -le "$f2" ] && [ "$f2" -le "$f3" ] &&
    [ "$f3" -le "$f4" ] && [ "$f4" -le "$f5" ] &&
    [ "$f5" -le "$f6" ] && [ "$f6" -eq 100 ]
}

# /etc/default/fan-control is intentionally parsed as a restricted assignment
# file instead of being sourced as root. This keeps recovery available even if
# an operator accidentally writes shell syntax or a failing command into it.
load_configuration_file() {
  local config_file="$1"
  local raw line key value first last remainder
  local -A parsed=()

  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw#"${raw%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ''|'#'*) continue ;;
    esac

    case "$line" in
      [A-Z][A-Z0-9_]*=*)
        key="${line%%=*}"
        value="${line#*=}"
        ;;
      *) return 1 ;;
    esac
    configuration_key_is_supported "$key" || return 1

    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [ -n "$value" ]; then
      first="${value:0:1}"
      last="${value: -1}"
      if [ "$first" = '"' ] || [ "$first" = "'" ]; then
        [ "$last" = "$first" ] && [ "${#value}" -ge 2 ] || return 1
        value="${value:1:${#value}-2}"
      elif [ "$last" = '"' ] || [ "$last" = "'" ]; then
        return 1
      fi
    fi
    case "$value" in
      *'"'*|*"'"*|*$'\r'*|*$'\n'*|*$'\t'*) return 1 ;;
    esac
    remainder="${value//[a-zA-Z0-9_ -]/}"
    [ -z "$remainder" ] || return 1
    configuration_value_is_supported "$key" "$value" || return 1
    parsed["$key"]="$value"
  done < "$config_file"

  configuration_curve_is_safe \
    "${parsed[TEMP_1]:-40}" "${parsed[TEMP_2]:-50}" "${parsed[TEMP_3]:-60}" \
    "${parsed[TEMP_4]:-70}" "${parsed[TEMP_5]:-78}" \
    "${parsed[GPU_PCT_1]:-45}" "${parsed[GPU_PCT_2]:-55}" "${parsed[GPU_PCT_3]:-70}" \
    "${parsed[GPU_PCT_4]:-85}" "${parsed[GPU_PCT_5]:-95}" "${parsed[GPU_PCT_6]:-100}" \
    "${parsed[FAN_PCT_1]:-50}" "${parsed[FAN_PCT_2]:-65}" "${parsed[FAN_PCT_3]:-80}" \
    "${parsed[FAN_PCT_4]:-90}" "${parsed[FAN_PCT_5]:-100}" "${parsed[FAN_PCT_6]:-100}" || return 1

  for key in "${!parsed[@]}"; do
    printf -v "$key" '%s' "${parsed[$key]}"
  done
}

if [ -e "$CONFIG_FILE" ] || [ -L "$CONFIG_FILE" ]; then
  CONFIG_ERROR=''
  if [ "$VALIDATE_CONFIG_ONLY" -eq 1 ]; then
    [ -r "$CONFIG_FILE" ] || CONFIG_ERROR="unreadable configuration file"
  elif ! command -v stat >/dev/null 2>&1 || ! configuration_file_is_secure "$CONFIG_FILE"; then
    CONFIG_ERROR="insecure configuration file"
  elif [ ! -r "$CONFIG_FILE" ]; then
    CONFIG_ERROR="unreadable configuration file"
  fi
  if [ -z "$CONFIG_ERROR" ] && ! load_configuration_file "$CONFIG_FILE"; then
    CONFIG_ERROR="invalid configuration syntax or unsupported key/value, or unsafe curve"
  fi

  if [ -n "$CONFIG_ERROR" ]; then
    if [ "$RESTORE_ONLY" -eq 1 ]; then
      printf 'fan-control: WARNING: %s: %s; using built-in recovery defaults\n' "$CONFIG_ERROR" "$CONFIG_FILE" >&2
    else
      printf 'fan-control: refusing %s: %s\n' "$CONFIG_ERROR" "$CONFIG_FILE" >&2
      exit 78
    fi
  fi
fi

INTERVAL="${INTERVAL:-1}"
HWMON_ROOT="${FAN_CONTROL_HWMON_ROOT:-/sys/class/hwmon}"
RUNTIME_DIR="${FAN_CONTROL_RUNTIME_DIR:-/run/linux-llm-server-manager}"
LOCK_FILE="${FAN_CONTROL_LOCK_FILE:-$RUNTIME_DIR/fan-control-daemon.lock}"
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
GPU_AUTO_ENABLE_VALUE="${GPU_AUTO_ENABLE_VALUE:-2}"
BOARD_AUTO_ENABLE_VALUE="${BOARD_AUTO_ENABLE_VALUE:-5}"
BOARD_AUTO_ENABLE_NODES="${BOARD_AUTO_ENABLE_NODES:-pwm1_enable pwm2_enable pwm3_enable}"
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

if ! configuration_curve_is_safe \
  "$TEMP_1" "$TEMP_2" "$TEMP_3" "$TEMP_4" "$TEMP_5" \
  "$GPU_PCT_1" "$GPU_PCT_2" "$GPU_PCT_3" "$GPU_PCT_4" "$GPU_PCT_5" "$GPU_PCT_6" \
  "$FAN_PCT_1" "$FAN_PCT_2" "$FAN_PCT_3" "$FAN_PCT_4" "$FAN_PCT_5" "$FAN_PCT_6"; then
  if [ "$RESTORE_ONLY" -eq 1 ]; then
    printf 'fan-control: WARNING: unsafe effective fan curve; recovery does not use curve values\n' >&2
  else
    printf 'fan-control: refusing unsafe effective fan curve: temperatures must rise strictly, PWM values must not decrease, and final PWM values must be 100%%\n' >&2
    exit 78
  fi
fi

if [ "$VALIDATE_CONFIG_ONLY" -eq 1 ]; then
  exit 0
fi

log() {
  printf '%s fan-control: %s\n' "$(date -Is)" "$*"
}

READY_NOTIFIED=0
notify_ready() {
  local status_message="$1"
  [ "$READY_NOTIFIED" -eq 0 ] || return 0

  if [ -n "${NOTIFY_SOCKET:-}" ]; then
    if ! command -v systemd-notify >/dev/null 2>&1; then
      log "CRITICAL: systemd-notify is required when the service uses Type=notify"
      return 1
    fi
    systemd-notify --ready --status="$status_message" || return 1
  fi
  READY_NOTIFIED=1
}

directory_is_secure_for_locking() {
  local directory="$1"
  local expected_uid="$2"
  local actual_uid mode

  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  actual_uid="$(stat -c '%u' -- "$directory" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' -- "$directory" 2>/dev/null)" || return 1
  [ "$actual_uid" = "$expected_uid" ] || return 1
  case "$mode" in
    *[2367][0-7]|*[0-7][2367]) return 1 ;;
  esac
}

prepare_secure_lock_file() {
  local lock_file="$1"
  local expected_uid=0
  local lock_dir parent_dir actual_uid mode

  if [ "${FAN_CONTROL_ALLOW_NON_ROOT_TESTING:-0}" = "1" ]; then
    expected_uid="$(id -u)"
  fi

  lock_dir="$(dirname -- "$lock_file")" || return 1
  parent_dir="$(dirname -- "$lock_dir")" || return 1
  directory_is_secure_for_locking "$parent_dir" "$expected_uid" || return 1
  [ ! -L "$lock_dir" ] || return 1
  if [ ! -e "$lock_dir" ]; then
    (umask 022; mkdir -p -- "$lock_dir") || return 1
  fi
  directory_is_secure_for_locking "$lock_dir" "$expected_uid" || return 1

  [ ! -L "$lock_file" ] || return 1
  if [ ! -e "$lock_file" ]; then
    (umask 077; : > "$lock_file") || return 1
  fi
  [ -f "$lock_file" ] && [ ! -L "$lock_file" ] || return 1
  actual_uid="$(stat -c '%u' -- "$lock_file" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' -- "$lock_file" 2>/dev/null)" || return 1
  [ "$actual_uid" = "$expected_uid" ] || return 1
  case "$mode" in
    *[2367][0-7]|*[0-7][2367]) return 1 ;;
  esac
}

is_safe_node_name() {
  case "$1" in
    ''|*[!a-zA-Z0-9_]*) return 1 ;;
    *) return 0 ;;
  esac
}

hwmon_name_matches() {
  local name="$1"
  local wanted_names="$2"
  case " $wanted_names " in
    *" $name "*) return 0 ;;
    *) return 1 ;;
  esac
}

find_hwmons() {
  local wanted_names="$1"
  local h name
  for h in "$HWMON_ROOT"/hwmon*; do
    [ -r "$h/name" ] || continue
    name="$(cat "$h/name" 2>/dev/null || true)"
    if hwmon_name_matches "$name" "$wanted_names"; then
      printf '%s\n' "$h"
    fi
  done
}

find_hwmon() {
  local wanted_names="$1"
  local h
  while IFS= read -r h; do
    printf '%s\n' "$h"
    return 0
  done < <(find_hwmons "$wanted_names")
  return 1
}

find_board_hwmons() {
  local h name
  for h in "$HWMON_ROOT"/hwmon*; do
    [ -r "$h/name" ] || continue
    name="$(cat "$h/name" 2>/dev/null || true)"
    if hwmon_name_matches "$name" "$GPU_HWMON_NAMES"; then
      continue
    fi
    if hwmon_name_matches "$name" "$BOARD_HWMON_NAMES" ||
      case "$name" in nct*|it87*|w83627*|f718*) true ;; *) false ;; esac ||
      [ -e "$h/pwm1" ] || [ -e "$h/pwm2" ]; then
      printf '%s\n' "$h"
    fi
  done
}

find_board_hwmon() {
  local h name
  for h in "$HWMON_ROOT"/hwmon*; do
    [ -r "$h/name" ] || continue
    name="$(cat "$h/name" 2>/dev/null || true)"
    if hwmon_name_matches "$name" "$GPU_HWMON_NAMES"; then
      continue
    fi
    if hwmon_name_matches "$name" "$BOARD_HWMON_NAMES" ||
      case "$name" in nct*|it87*|w83627*|f718*) true ;; *) false ;; esac; then
      printf '%s\n' "$h"
      return 0
    fi
  done
  for h in "$HWMON_ROOT"/hwmon*; do
    [ -r "$h/name" ] || continue
    name="$(cat "$h/name" 2>/dev/null || true)"
    if ! hwmon_name_matches "$name" "$GPU_HWMON_NAMES" &&
      { [ -e "$h/pwm1" ] || [ -e "$h/pwm2" ]; }; then
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
  local raw readback diff

  [ -n "$hwmon" ] || return 1
  is_safe_node_name "$pwm_node" || return 1
  is_safe_node_name "$enable_node" || return 1
  case "$percent" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$percent" -ge 0 ] && [ "$percent" -le 100 ] || return 1
  [ -w "$hwmon/$pwm_node" ] || return 1
  raw="$((percent * 255 / 100))"

  if [ -e "$hwmon/$enable_node" ]; then
    [ -w "$hwmon/$enable_node" ] || return 1
    printf '1\n' > "$hwmon/$enable_node"
  fi
  printf '%s\n' "$raw" > "$hwmon/$pwm_node"
  readback="$(cat "$hwmon/$pwm_node" 2>/dev/null || true)"
  case "$readback" in
    ''|*[!0-9-]*) return 1 ;;
  esac
  diff="$((readback - raw))"
  [ "$diff" -lt 0 ] && diff="$(( -diff ))"
  [ "$diff" -le 2 ]
}

read_node_or_na() {
  local hwmon="$1"
  local node="$2"
  if [ -n "$hwmon" ] && is_safe_node_name "$node" && [ -r "$hwmon/$node" ]; then
    cat "$hwmon/$node" 2>/dev/null || printf 'N/A\n'
  else
    printf 'N/A\n'
  fi
}

# Leave every controller in a safe state even if the daemon is stopped or
# crashes: first request full speed while still in manual mode, then hand
# control back to the hardware driver. If automatic-mode restoration fails,
# the preceding full-speed write is intentionally left in place.
restore_pwm_automatic() {
  local hwmon="$1"
  local pwm_node="$2"
  local enable_node="$3"
  local automatic_value="$4"
  local enable_path pwm_path readback current_mode
  local full_speed_ok=1
  local automatic_ok=1

  [ -n "$hwmon" ] || return 0
  is_safe_node_name "$pwm_node" || return 1
  is_safe_node_name "$enable_node" || return 1
  pwm_path="$hwmon/$pwm_node"
  enable_path="$hwmon/$enable_node"

  current_mode=''
  if [ -e "$enable_path" ]; then
    current_mode="$(cat "$enable_path" 2>/dev/null || true)"
    if [ "$current_mode" = "$automatic_value" ]; then
      return 0
    fi
  fi

  # pwmN controls the fan only in manual mode on the standard hwmon ABI. Do
  # not touch the PWM value when the controller is already automatic. For an
  # explicitly manual (or unreadable/write-only) controller, request full
  # speed before handing it back to hardware control.
  if [ -e "$pwm_path" ] && { [ ! -e "$enable_path" ] || [ "$current_mode" = "1" ] || [ -z "$current_mode" ]; }; then
    if [ ! -w "$pwm_path" ] || ! printf '255\n' > "$pwm_path"; then
      full_speed_ok=0
    fi
  fi

  if [ -e "$enable_path" ]; then
    if [ ! -w "$enable_path" ] || ! printf '%s\n' "$automatic_value" > "$enable_path"; then
      automatic_ok=0
    else
      readback="$(cat "$enable_path" 2>/dev/null || true)"
      [ "$readback" = "$automatic_value" ] || automatic_ok=0
    fi
  fi

  # Code 1 means automatic-mode restoration itself failed. Code 2 means the
  # automatic handoff succeeded but the preceding full-speed request failed.
  [ "$automatic_ok" -eq 1 ] || return 1
  [ "$full_speed_ok" -eq 1 ] || return 2
  return 0
}

restore_automatic_mode() {
  local gpu_hwmon board_hwmon enable_node pwm_node
  local -a board_enable_nodes=()
  local attempted=0 result
  local failures=0

  while IFS= read -r gpu_hwmon; do
    [ -n "$gpu_hwmon" ] || continue
    attempted=$((attempted + 1))
    if restore_pwm_automatic "$gpu_hwmon" "$GPU_PWM_NODE" "$GPU_PWM_ENABLE_NODE" "$GPU_AUTO_ENABLE_VALUE"; then
      :
    else
      result=$?
      if [ "$result" -eq 2 ]; then
        log "WARNING: restored automatic mode but could not request full speed first for $gpu_hwmon/$GPU_PWM_NODE"
      else
        failures=$((failures + 1))
        log "WARNING: failed to restore automatic mode for $gpu_hwmon/$GPU_PWM_ENABLE_NODE"
      fi
    fi
  done < <(find_hwmons "$GPU_HWMON_NAMES")

  while IFS= read -r board_hwmon; do
    [ -n "$board_hwmon" ] || continue
    read -r -a board_enable_nodes <<< "$BOARD_AUTO_ENABLE_NODES" || true
    for enable_node in "${board_enable_nodes[@]}"; do
      if ! is_safe_node_name "$enable_node"; then
        failures=$((failures + 1))
        log "WARNING: ignored unsafe board PWM enable node: $enable_node"
        continue
      fi
      pwm_node="${enable_node%_enable}"
      if [ -e "$board_hwmon/$pwm_node" ] || [ -e "$board_hwmon/$enable_node" ]; then
        attempted=$((attempted + 1))
        if restore_pwm_automatic "$board_hwmon" "$pwm_node" "$enable_node" "$BOARD_AUTO_ENABLE_VALUE"; then
          :
        else
          result=$?
          if [ "$result" -eq 2 ]; then
            log "WARNING: restored automatic mode but could not request full speed first for $board_hwmon/$pwm_node"
          else
            failures=$((failures + 1))
            log "WARNING: failed to restore automatic mode for $board_hwmon/$enable_node"
          fi
        fi
      fi
    done
  done < <(find_board_hwmons)

  if [ "$attempted" -eq 0 ]; then
    log "No controllable PWM nodes were present during automatic-mode restoration"
  elif [ "$failures" -eq 0 ]; then
    log "Restored automatic fan control on $attempted PWM controller(s)"
  else
    log "CRITICAL: automatic-mode restoration had $failures failure(s); failed automatic handoffs were left at best-effort full speed"
  fi

  # Cleanup remains best-effort so all controllers are attempted, but the
  # standalone --restore-auto invocation reports automatic handoff failures.
  [ "$failures" -eq 0 ]
}

handle_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  log "Daemon exiting with status $status; restoring automatic fan control"
  restore_automatic_mode
  exit "$status"
}

if ! command -v flock >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then
  log "CRITICAL: flock and stat are required to secure concurrent fan-control daemons"
  exit 1
fi

if ! prepare_secure_lock_file "$LOCK_FILE"; then
  log "CRITICAL: refusing insecure daemon lock path: $LOCK_FILE"
  exit 1
fi
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another fan-control daemon already holds $LOCK_FILE"
  exit 1
fi

if [ "${1:-}" = "--restore-auto" ]; then
  restore_automatic_mode
  exit 0
fi

trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

# A dashboard manual/preset operation can leave CPU and auxiliary channels in
# manual mode while this service is inactive. Restore every configured channel
# before taking ownership of the GPU and external-fan channels below.
if ! restore_automatic_mode; then
  log "CRITICAL: startup recovery could not restore every configured automatic PWM mode"
  exit 1
fi

trap handle_exit EXIT

while true; do
  GPU_HWMON="$(find_hwmon "$GPU_HWMON_NAMES" || true)"
  BOARD_HWMON="$(find_board_hwmon "$GPU_HWMON" || true)"

  if [ -z "$GPU_HWMON" ]; then
    log "GPU hwmon not found; forcing the external fan to full speed"
    if ! set_pwm_percent "$BOARD_HWMON" "$FAN_PWM_NODE" "$FAN_PWM_ENABLE_NODE" 100; then
      log "CRITICAL: no GPU sensor and the external fan could not be forced to full speed"
      exit 1
    fi
    if ! notify_ready "GPU sensor unavailable; external fan verified at full speed"; then
      log "CRITICAL: failed to report fan-control readiness"
      exit 1
    fi
    sleep 5
    continue
  fi

  PRIMARY_TEMP_NODE="$(resolve_temp_input "$GPU_HWMON" "$GPU_TEMP_INPUT" primary || true)"
  MEMORY_TEMP_NODE="$(resolve_temp_input "$GPU_HWMON" "$GPU_MEMORY_TEMP_INPUT" memory || true)"
  PRIMARY_TEMP="$(read_temp_c "$PRIMARY_TEMP_NODE" || true)"

  if [ -z "$PRIMARY_TEMP" ]; then
    log "GPU temperature sensor unavailable; forcing controllable fans to full speed"
    WRITE_FAILED=0
    set_pwm_percent "$GPU_HWMON" "$GPU_PWM_NODE" "$GPU_PWM_ENABLE_NODE" 100 || WRITE_FAILED=1
    if [ -n "$BOARD_HWMON" ]; then
      set_pwm_percent "$BOARD_HWMON" "$FAN_PWM_NODE" "$FAN_PWM_ENABLE_NODE" 100 || WRITE_FAILED=1
    fi
    if [ "$WRITE_FAILED" -ne 0 ]; then
      log "CRITICAL: a controllable fan could not be forced to full speed after temperature loss"
      exit 1
    fi
    if ! notify_ready "GPU temperature unavailable; controllable fans verified at full speed"; then
      log "CRITICAL: failed to report fan-control readiness"
      exit 1
    fi
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

  if ! set_pwm_percent "$GPU_HWMON" "$GPU_PWM_NODE" "$GPU_PWM_ENABLE_NODE" "$GPU_PCT"; then
    log "CRITICAL: failed to apply or verify the GPU fan PWM request"
    exit 1
  fi
  if [ -n "$BOARD_HWMON" ] && ! set_pwm_percent "$BOARD_HWMON" "$FAN_PWM_NODE" "$FAN_PWM_ENABLE_NODE" "$FAN_PCT"; then
    log "CRITICAL: failed to apply or verify the external fan PWM request"
    exit 1
  fi
  if ! notify_ready "Automatic fan curve active and initial PWM writes verified"; then
    log "CRITICAL: failed to report fan-control readiness"
    exit 1
  fi

  GPU_PWM_REAL="$(read_node_or_na "$GPU_HWMON" "$GPU_PWM_NODE")"
  GPU_RPM="$(read_node_or_na "$GPU_HWMON" "$GPU_RPM_NODE")"
  FAN_PWM_REAL="$(read_node_or_na "$BOARD_HWMON" "$FAN_PWM_NODE")"
  FAN_RPM="$(read_node_or_na "$BOARD_HWMON" "$FAN_RPM_NODE")"
  MEMORY_DISPLAY="${MEMORY_TEMP:-N/A}"

  log "gpu=${PRIMARY_TEMP}C memory=${MEMORY_DISPLAY}C control=${CONTROL_TEMP}C | GPU=${GPU_PCT}% (${GPU_PWM_REAL}/255) ${GPU_RPM}RPM | Fan=${FAN_PCT}% (${FAN_PWM_REAL}/255) ${FAN_RPM}RPM"
  sleep "$INTERVAL"
done
