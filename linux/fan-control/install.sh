#!/usr/bin/env bash
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo ./install.sh" >&2
  exit 1
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_PATH=/etc/default/fan-control
SERVICE_PATH=/etc/systemd/system/fan-control.service
SCRIPT_PATH=/usr/local/sbin/fan-control.sh

install -d -m 0755 /usr/local/sbin /etc/systemd/system /etc/default
install -m 0755 "$SOURCE_DIR/fan-control.sh" "$SCRIPT_PATH"
install -m 0644 "$SOURCE_DIR/fan-control.service" "$SERVICE_PATH"

if [ ! -e "$CONFIG_PATH" ]; then
  install -m 0644 "$SOURCE_DIR/fan-control.conf" "$CONFIG_PATH"
  echo "Created $CONFIG_PATH"
else
  echo "Preserved existing $CONFIG_PATH"
fi

systemctl daemon-reload

if systemctl cat mi50-fan-control.service >/dev/null 2>&1; then
  systemctl disable --now mi50-fan-control.service >/dev/null 2>&1 || true
  echo "Disabled legacy fan service; its files were preserved for rollback."
fi

systemctl enable --now fan-control.service
systemctl --no-pager --full status fan-control.service || true

echo
echo "fan-control installed successfully."
echo "Configuration: $CONFIG_PATH"
echo "Logs: journalctl -u fan-control.service -f"
