# Generic Linux fan-control service

This package provides the optional Linux-side cooling daemon used by the dashboard. The dashboard itself runs without it, but automatic fan curves, service controls, and service logs require fan-control.service on the target Linux host.

Hardware warning: this service writes directly to Linux hwmon PWM nodes. Verify the node mapping and keep physical temperature monitoring available during initial testing.

## Download and install

On the target Linux server:

    git clone --depth 1 https://github.com/wqwd1dfse/linux-llm-server-manager.git
    cd linux-llm-server-manager/linux/fan-control
    sudo ./install.sh

The installer copies:

- fan-control.sh to /usr/local/sbin/fan-control.sh
- fan-control.service to /etc/systemd/system/fan-control.service
- fan-control.conf to /etc/default/fan-control on first install only

If a legacy hardware-specific fan service exists, the installer disables it but preserves its files.

## Configure hardware nodes

Inspect the available sensors first:

    sensors
    for h in /sys/class/hwmon/hwmon*; do
      printf '%s: ' "$h"
      cat "$h/name" 2>/dev/null
    done

Then edit /etc/default/fan-control. The defaults automatically detect AMD GPU temperature labels and use motherboard pwm2 for the external fan. Override the node names when your hardware layout differs.

After changes:

    sudo systemctl restart fan-control.service
    sudo systemctl status fan-control.service
    sudo journalctl -u fan-control.service -f
