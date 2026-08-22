#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEST_ROOT="${FAN_CONTROL_INSTALL_ROOT:-}"
SYSTEMCTL="${FAN_CONTROL_SYSTEMCTL:-systemctl}"
RUNTIME_DIR="${FAN_CONTROL_RUNTIME_DIR:-/run/linux-llm-server-manager}"
OPERATION_LOCK_FILE="${FAN_CONTROL_OPERATION_LOCK_FILE:-$RUNTIME_DIR/fan-control-operation.lock}"
STARTUP_STABILITY_SECONDS="${FAN_CONTROL_STARTUP_STABILITY_SECONDS:-5}"

if [ "$(id -u)" -ne 0 ] && { [ "${FAN_CONTROL_ALLOW_NON_ROOT_TESTING:-0}" != "1" ] || [ -z "$DEST_ROOT" ]; }; then
  echo "Run this installer as root: sudo ./install.sh" >&2
  exit 1
fi
case "$STARTUP_STABILITY_SECONDS" in
  ''|*[!0-9]*)
    echo "FAN_CONTROL_STARTUP_STABILITY_SECONDS must be an integer from 1 to 60." >&2
    exit 2
    ;;
esac
if [ "$STARTUP_STABILITY_SECONDS" -lt 1 ] || [ "$STARTUP_STABILITY_SECONDS" -gt 60 ]; then
  echo "FAN_CONTROL_STARTUP_STABILITY_SECONDS must be an integer from 1 to 60." >&2
  exit 2
fi

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

  if [ "${FAN_CONTROL_ALLOW_NON_ROOT_TESTING:-0}" = "1" ] && [ -n "$DEST_ROOT" ]; then
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

configuration_file_is_secure() {
  local config_file="$1"
  local expected_uid=0
  local actual_uid mode

  if [ "${FAN_CONTROL_ALLOW_NON_ROOT_TESTING:-0}" = "1" ] && [ -n "$DEST_ROOT" ]; then
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

if ! command -v flock >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then
  echo "flock and stat are required to secure fan-control installation and dashboard operations." >&2
  exit 1
fi
if ! prepare_secure_lock_file "$OPERATION_LOCK_FILE"; then
  echo "Refusing insecure fan-control operation lock path: $OPERATION_LOCK_FILE" >&2
  exit 1
fi
exec 8>>"$OPERATION_LOCK_FILE"
if ! flock -x -w 30 -E 75 8; then
  echo "Another fan-control operation is still running; installation was not started." >&2
  exit 75
fi

CONFIG_PATH="$DEST_ROOT/etc/default/fan-control"
SERVICE_PATH="$DEST_ROOT/etc/systemd/system/fan-control.service"
SCRIPT_PATH="$DEST_ROOT/usr/local/sbin/fan-control.sh"
NEW_SERVICE=fan-control.service
LEGACY_SERVICE=mi50-fan-control.service

TRANSACTION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fan-control-install.XXXXXX")"
BACKUP_DIR="$TRANSACTION_DIR/backups"
STAGE_DIR="$TRANSACTION_DIR/stage"
SCRIPT_TEMP="$SCRIPT_PATH.install.$$"
SERVICE_TEMP="$SERVICE_PATH.install.$$"
CONFIG_TEMP="$CONFIG_PATH.install.$$"

COMMITTED=0
INSTALLATION_STARTED=0
SCRIPT_EXISTED=0
SERVICE_EXISTED=0
CONFIG_CREATED=0
NEW_SERVICE_EXISTED=0
NEW_WAS_ENABLED=0
NEW_WAS_ACTIVE=0
LEGACY_SERVICE_EXISTED=0
LEGACY_WAS_ENABLED=0
LEGACY_WAS_ACTIVE=0

service_load_state() {
  "$SYSTEMCTL" show "$1" --property=LoadState --value 2>/dev/null
}

service_is_enabled() {
  "$SYSTEMCTL" is-enabled --quiet "$1" >/dev/null 2>&1
}

service_is_active() {
  "$SYSTEMCTL" is-active --quiet "$1" >/dev/null 2>&1
}

wait_for_service_stability() {
  local service="$1"
  local elapsed=0

  service_is_active "$service" || return 1
  while [ "$elapsed" -lt "$STARTUP_STABILITY_SECONDS" ]; do
    sleep 1
    service_is_active "$service" || return 1
    elapsed=$((elapsed + 1))
  done
}

restore_file() {
  local path="$1"
  local backup_name="$2"
  local existed="$3"
  if [ "$existed" -eq 1 ]; then
    cp -a "$BACKUP_DIR/$backup_name" "$path"
  else
    rm -f -- "$path"
  fi
}

restore_service_state() {
  local service="$1"
  local existed="$2"
  local was_enabled="$3"
  local was_active="$4"

  if [ "$existed" -ne 1 ]; then
    "$SYSTEMCTL" disable "$service" >/dev/null 2>&1 || true
    service_is_enabled "$service" && return 1
    service_is_active "$service" && return 1
    return 0
  fi
  if [ "$was_enabled" -eq 1 ]; then
    "$SYSTEMCTL" enable "$service" >/dev/null 2>&1 || true
  else
    "$SYSTEMCTL" disable "$service" >/dev/null 2>&1 || true
  fi
  if [ "$was_active" -eq 1 ]; then
    "$SYSTEMCTL" start "$service" >/dev/null 2>&1 || true
  else
    "$SYSTEMCTL" stop "$service" >/dev/null 2>&1 || true
  fi

  if [ "$was_enabled" -eq 1 ]; then
    service_is_enabled "$service" || return 1
  else
    service_is_enabled "$service" && return 1
  fi
  if [ "$was_active" -eq 1 ]; then
    service_is_active "$service" || return 1
  else
    service_is_active "$service" && return 1
  fi
  return 0
}

rollback() {
  local status=$?
  local rollback_failures=0
  trap - EXIT INT TERM HUP
  set +e

  rm -f -- "$SCRIPT_TEMP" "$SERVICE_TEMP" "$CONFIG_TEMP"
  if [ "$COMMITTED" -eq 1 ]; then
    rm -rf -- "$TRANSACTION_DIR"
    exit "$status"
  fi
  if [ "$INSTALLATION_STARTED" -eq 0 ]; then
    rm -rf -- "$TRANSACTION_DIR"
    exit "$status"
  fi

  [ "$status" -ne 0 ] || status=1
  echo "fan-control installation failed; rolling back files and service state." >&2

  "$SYSTEMCTL" stop "$NEW_SERVICE" >/dev/null 2>&1 || true
  if [ "$NEW_SERVICE_EXISTED" -eq 0 ]; then
    "$SYSTEMCTL" disable "$NEW_SERVICE" >/dev/null 2>&1 || true
  fi
  restore_file "$SCRIPT_PATH" fan-control.sh "$SCRIPT_EXISTED" || rollback_failures=$((rollback_failures + 1))
  restore_file "$SERVICE_PATH" fan-control.service "$SERVICE_EXISTED" || rollback_failures=$((rollback_failures + 1))
  if [ "$CONFIG_CREATED" -eq 1 ]; then
    rm -f -- "$CONFIG_PATH" || rollback_failures=$((rollback_failures + 1))
  fi
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || rollback_failures=$((rollback_failures + 1))

  restore_service_state "$NEW_SERVICE" "$NEW_SERVICE_EXISTED" "$NEW_WAS_ENABLED" "$NEW_WAS_ACTIVE" || rollback_failures=$((rollback_failures + 1))
  restore_service_state "$LEGACY_SERVICE" "$LEGACY_SERVICE_EXISTED" "$LEGACY_WAS_ENABLED" "$LEGACY_WAS_ACTIVE" || rollback_failures=$((rollback_failures + 1))
  if [ "$rollback_failures" -ne 0 ]; then
    echo "CRITICAL: fan-control rollback completed with $rollback_failures failure(s); inspect both services and PWM mode immediately." >&2
  fi
  rm -rf -- "$TRANSACTION_DIR"
  exit "$status"
}

trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ -e "$CONFIG_PATH" ] || [ -L "$CONFIG_PATH" ]; then
  if ! configuration_file_is_secure "$CONFIG_PATH"; then
    echo "Refusing insecure existing configuration file: $CONFIG_PATH" >&2
    exit 78
  fi
fi

mkdir -p "$BACKUP_DIR" "$STAGE_DIR"

# Validate staged content and the preserved/default configuration before
# querying or mutating any service state.
install -m 0755 "$SOURCE_DIR/fan-control.sh" "$STAGE_DIR/fan-control.sh"
install -m 0644 "$SOURCE_DIR/fan-control.service" "$STAGE_DIR/fan-control.service"
bash -n "$STAGE_DIR/fan-control.sh"
grep -q '^ExecStopPost=.*/fan-control.sh --restore-auto$' "$STAGE_DIR/fan-control.service"
CONFIG_VALIDATION_PATH="$CONFIG_PATH"
if [ ! -e "$CONFIG_VALIDATION_PATH" ]; then
  install -m 0644 "$SOURCE_DIR/fan-control.conf" "$STAGE_DIR/fan-control.conf"
  CONFIG_VALIDATION_PATH="$STAGE_DIR/fan-control.conf"
fi
FAN_CONTROL_CONFIG="$CONFIG_VALIDATION_PATH" "$STAGE_DIR/fan-control.sh" --validate-config

NEW_LOAD_STATE="$(service_load_state "$NEW_SERVICE")" || {
  echo "Unable to inspect $NEW_SERVICE before installation; no changes were made." >&2
  exit 1
}
if [ -z "$NEW_LOAD_STATE" ]; then
  echo "Unable to determine $NEW_SERVICE load state; no changes were made." >&2
  exit 1
fi
if [ "$NEW_LOAD_STATE" != "not-found" ]; then
  NEW_SERVICE_EXISTED=1
  service_is_enabled "$NEW_SERVICE" && NEW_WAS_ENABLED=1
  service_is_active "$NEW_SERVICE" && NEW_WAS_ACTIVE=1
fi

LEGACY_LOAD_STATE="$(service_load_state "$LEGACY_SERVICE")" || {
  echo "Unable to inspect $LEGACY_SERVICE before installation; no changes were made." >&2
  exit 1
}
if [ -z "$LEGACY_LOAD_STATE" ]; then
  echo "Unable to determine $LEGACY_SERVICE load state; no changes were made." >&2
  exit 1
fi
if [ "$LEGACY_LOAD_STATE" != "not-found" ]; then
  LEGACY_SERVICE_EXISTED=1
  service_is_enabled "$LEGACY_SERVICE" && LEGACY_WAS_ENABLED=1
  service_is_active "$LEGACY_SERVICE" && LEGACY_WAS_ACTIVE=1
fi

if [ -e "$SCRIPT_PATH" ]; then
  SCRIPT_EXISTED=1
  cp -a "$SCRIPT_PATH" "$BACKUP_DIR/fan-control.sh"
fi
if [ -e "$SERVICE_PATH" ]; then
  SERVICE_EXISTED=1
  cp -a "$SERVICE_PATH" "$BACKUP_DIR/fan-control.service"
fi

INSTALLATION_STARTED=1
install -d -m 0755 "$DEST_ROOT/usr/local/sbin" "$DEST_ROOT/etc/systemd/system" "$DEST_ROOT/etc/default"

# Install through same-directory temporary files so each replacement is atomic.
install -m 0755 "$STAGE_DIR/fan-control.sh" "$SCRIPT_TEMP"
mv -f -- "$SCRIPT_TEMP" "$SCRIPT_PATH"
install -m 0644 "$STAGE_DIR/fan-control.service" "$SERVICE_TEMP"
mv -f -- "$SERVICE_TEMP" "$SERVICE_PATH"

if [ ! -e "$CONFIG_PATH" ]; then
  install -m 0644 "$STAGE_DIR/fan-control.conf" "$CONFIG_TEMP"
  CONFIG_CREATED=1
  mv -f -- "$CONFIG_TEMP" "$CONFIG_PATH"
  echo "Created $CONFIG_PATH"
else
  echo "Preserved existing $CONFIG_PATH"
fi

"$SYSTEMCTL" daemon-reload

# Never run two fan controllers at once. Stop the legacy unit only after the
# replacement files have passed validation, and retain its exact prior state
# so any failure below can restore it.
if [ "$LEGACY_SERVICE_EXISTED" -eq 1 ]; then
  "$SYSTEMCTL" stop "$LEGACY_SERVICE"
  if service_is_active "$LEGACY_SERVICE"; then
    echo "Legacy fan service did not stop; refusing to start a competing controller." >&2
    exit 1
  fi
fi

"$SYSTEMCTL" enable "$NEW_SERVICE"
"$SYSTEMCTL" restart "$NEW_SERVICE"
if ! wait_for_service_stability "$NEW_SERVICE"; then
  echo "fan-control.service did not remain active for the ${STARTUP_STABILITY_SECONDS}s startup stability window." >&2
  exit 1
fi

# Disable legacy autostart only after the replacement is confirmed active.
if [ "$LEGACY_WAS_ENABLED" -eq 1 ]; then
  "$SYSTEMCTL" disable "$LEGACY_SERVICE"
fi

COMMITTED=1
"$SYSTEMCTL" --no-pager --full status "$NEW_SERVICE" || true

echo
echo "fan-control installed successfully."
echo "Configuration: $CONFIG_PATH"
echo "Logs: journalctl -u fan-control.service -f"
