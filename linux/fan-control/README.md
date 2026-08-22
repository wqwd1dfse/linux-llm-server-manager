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

If a legacy hardware-specific fan service exists, the installer stages and validates the replacement first, stops the legacy unit, waits for the daemon's explicit systemd readiness signal after its first verified safe PWM writes, and then requires the unit to remain active for a five-second startup stability window before it disables legacy autostart. The default configuration is installed from the same private staged copy that was validated. Any failure restores the previous files plus the enabled/active state of both services. Advanced operators can set `FAN_CONTROL_STARTUP_STABILITY_SECONDS` to an integer from 1 to 60 for a longer or shorter post-readiness check.

## Configure hardware nodes

Inspect the available sensors first:

    sensors
    for h in /sys/class/hwmon/hwmon*; do
      printf '%s: ' "$h"
      cat "$h/name" 2>/dev/null
    done

Then edit /etc/default/fan-control. The defaults automatically detect AMD GPU temperature labels and use motherboard pwm2 for the external fan. Override the node names when your hardware layout differs.

`GPU_AUTO_ENABLE_VALUE`, `BOARD_AUTO_ENABLE_VALUE`, and `BOARD_AUTO_ENABLE_NODES` control recovery. Before each daemon start, and again on `TERM`, `INT`, `HUP`, an unexpected shell error, or a normal service stop, the daemon returns every configured channel on every detected GPU and supported/fallback board controller to hardware automatic mode. A channel that is already in the requested automatic mode is left untouched; a channel confirmed to be in manual mode is first requested at full speed. Startup recovery prevents secondary GPUs, CPU, auxiliary channels, and fallback PWM controllers touched by a dashboard preset from remaining pinned in manual mode. The systemd unit repeats shutdown recovery through `ExecStopPost` if the main process cannot complete its own trap.

Daemon and dashboard mutations are serialized with lock files under `/run/linux-llm-server-manager`. The scripts create this root-controlled runtime directory when needed and refuse symlinked, non-root-owned, or group/world-writable lock paths. A standalone `fan-control.sh --restore-auto` also takes the daemon lock and refuses to race an active controller.

The daemon reads `/etc/default/fan-control` as a restricted `KEY=value` assignment file; it does not execute the file as shell code. Only the documented keys and plain alphanumeric, underscore, hyphen, or space values are accepted. Temperature thresholds must increase strictly, GPU and external-fan PWM percentages must never decrease, and both highest-temperature PWM values must be `100`. Both the installer and daemon require an existing configuration to be a regular, root-owned file that is not group- or world-writable; symbolic links are rejected. The installer creates a missing configuration as mode `0644` owned by root. During shutdown recovery, an invalid configuration is ignored and built-in safe recovery defaults are used so `ExecStopPost` can still attempt the hardware handoff. Configuration errors exit with status `78`, which systemd does not restart automatically; fix the file and restart the unit explicitly.

The service uses `Type=notify`; `systemd-notify` (normally shipped with systemd) must be available. systemd does not consider the daemon started until automatic-mode recovery and an initial safe PWM write/readback have succeeded.

After changes:

    sudo systemctl restart fan-control.service
    sudo systemctl status fan-control.service
    sudo journalctl -u fan-control.service -f

## Roll back or uninstall

Stopping the service is safe: shutdown recovery runs before systemd reports the unit stopped.

    sudo systemctl stop fan-control.service

To return to a preserved legacy service:

    sudo systemctl disable --now fan-control.service
    sudo systemctl enable --now mi50-fan-control.service

After verifying that hardware automatic mode or the legacy controller is active, the installed generic files can be removed and systemd reloaded:

    sudo rm -f /etc/systemd/system/fan-control.service /usr/local/sbin/fan-control.sh
    sudo systemctl daemon-reload

The installer never overwrites an existing `/etc/default/fan-control`. Remove that configuration separately only when it is no longer needed.
