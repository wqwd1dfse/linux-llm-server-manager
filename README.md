# Linux LLM Server Manager

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wqwd1dfse/linux-llm-server-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/wqwd1dfse/linux-llm-server-manager/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lightweight web dashboard for managing Linux servers and local LLM inference systems through a Windows 11-inspired interface.

It combines system telemetry, an SSH terminal, SFTP file management, Docker, systemd, cooling controls, GPU monitoring, Hugging Face downloads, and llama-server management in one application.

## Features

- **Hardware telemetry** — CPU, memory, swap, disks, network throughput, and multi-GPU temperature, power, utilization, and VRAM data.
- **Web SSH terminal** — interactive Bash/Zsh sessions with xterm.js, authenticated WebSocket upgrades, and strict Origin validation.
- **SFTP file manager** — navigation, per-server favorites, recoverable trash, bounded uploads, editing, chmod, path-safe archive extraction, and image previews.
- **LLM Studio** — validated llama-server parameters, SSH-forwarded loopback access, streaming chat, Hugging Face downloads, and launch presets.
- **Cooling console** — PWM controls, automatic/full-speed/quiet presets, sensor probing, readback verification, and fail-safe recovery.
- **Docker and systemd management** — containers, images, logs, processes, services, and lifecycle controls.
- **Multiple server profiles** — quickly switch between SSH targets while keeping credentials on the local manager.
- **English and Simplified Chinese UI** — English is the default for new users; saved language choices are preserved.
- **Responsive and accessible UI** — keyboard navigation, focus management, reduced-motion support, and narrow-screen layouts.

## Security

> [!IMPORTANT]
> This application can control SSH sessions, files, Docker, systemd, model processes, and hardware cooling. Keep it bound to `127.0.0.1` and expose it only through a trusted VPN or HTTPS reverse proxy. Do not publish the management port directly to the internet.

Security controls include:

- Loopback-only default binding.
- PBKDF2-HMAC-SHA512 password hashing with 220,000 iterations.
- Signed `HttpOnly`, `SameSite=Lax` session cookies.
- Login rate limiting and expiring server-side sessions.
- SSH host-key trust-on-first-use verification that rejects changed fingerprints by default.
- Array-based command execution without shell string interpolation.
- A strict Content Security Policy with inline event handlers disabled.
- Loopback-only first-run setup unless `ALLOW_REMOTE_SETUP=true` is explicitly configured.
- In-memory SSH credentials unless local persistence is explicitly enabled.
- Archive traversal, symlink, entry-count, and expanded-size defenses.
- Permission-restricted temporary curl configuration for remote Hugging Face downloads.

Rotate any real credentials used during development and verify that secrets have never been committed to Git history.

## Quick start

Requirements:

- Node.js 18 or newer; Node.js 20 LTS or 22 is recommended.
- npm 9 or newer.
- A Linux server reachable over SSH.

```bash
git clone https://github.com/wqwd1dfse/linux-llm-server-manager.git
cd linux-llm-server-manager
npm ci
cp .env.example .env
npm start
```

Windows PowerShell users can replace the copy command with:

```powershell
Copy-Item .env.example .env
```

Open [http://127.0.0.1:3888](http://127.0.0.1:3888). On first launch, create the administrator credentials.

For development with Node.js watch mode:

```bash
npm run dev
```

## Optional Linux fan-control service

The dashboard can read hardware sensors without an extra daemon. Automatic fan curves, service start/stop controls, and service logs additionally require fan-control.service on each target Linux host.

Download and install it on the target host:

    git clone --depth 1 https://github.com/wqwd1dfse/linux-llm-server-manager.git
    cd linux-llm-server-manager/linux/fan-control
    sudo ./install.sh

Review /etc/default/fan-control before unattended use because hwmon PWM node layouts vary by motherboard and GPU. See linux/fan-control/README.md for configuration and rollback instructions.

## Configuration

See [.env.example](.env.example) for every option. Common settings include:

```ini
HOST=127.0.0.1
PORT=3888

ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_admin_password_here
SESSION_SECRET=change_this_to_a_random_long_string_in_production

AUTO_CONNECT=true
ALLOW_REMOTE_SETUP=false
TRUST_PROXY=false
ENABLE_CUSTOM_SCRIPTS=false
SSH_STRICT_HOST_CHECK=true

MODEL_ROOTS=/mnt/models,/opt/models
MODEL_SCAN_MAX_DEPTH=4
LLM_BIND_HOST=127.0.0.1
METRICS_INTERVAL=2000

MAX_UPLOAD_FILE_MB=512
MAX_UPLOAD_FILES=10
MAX_ARCHIVE_ENTRIES=10000
MAX_ARCHIVE_EXPANDED_MB=102400
```

Keep `HOST` and `LLM_BIND_HOST` on loopback by default. Enable `TRUST_PROXY` only for a known reverse proxy topology, and enable custom scripts only for trusted administrators.

## Languages

The interface supports English (`en-US`) and Simplified Chinese (`zh-CN`). Change it from **System & Preferences → Display Language**; the browser stores the choice and applies it without a page reload.

Translation code is split between:

- `public/js/i18n.js` — locale state, DOM translation, dynamic content, and language switching.
- `public/js/i18nCatalog.js` — shared English/Simplified Chinese UI phrases.

## Architecture

The frontend uses native JavaScript and Express without a build step or extra runtime dependency. Feature scripts load only when their view is opened for the first time:

- `public/index.html` — application shell and primary views.
- `public/fragments/modals.html` — trusted modal and context-menu fragment.
- `public/js/bootstrap.js` — validates and loads the fragment before application initialization.
- `public/js/markdown.js` — escaped Markdown rendering.
- `public/js/terminal.js` — lazily loads xterm.js.
- The browser loads `base.css`, `components.css`, and `polish.css` in parallel; `public/css/style.css` remains as a compatibility entry point.

## Tests

```bash
npm test
```

Tests cover authentication, atomic persistence, strict SSH host-key pinning, sessions, rate limiting, HTTP error flows, WebSocket Origin checks, command-injection defenses, LLM validation, model-path boundaries, archive allowlists, telemetry retention, escaped Markdown, frontend hardening, and internationalization regressions. CI runs on Node.js 18, 20, and 22.

## Production deployment

Keep the application on loopback and put Nginx, Caddy, or another trusted HTTPS reverse proxy in front of it. Forward the original host, client IP, protocol, and WebSocket Upgrade headers. Use a stable random `SESSION_SECRET` and configure `TRUST_PROXY` to match only the actual proxy topology.

## License

Maintained by **wqwd1dfse** and released under the [MIT License](LICENSE).
