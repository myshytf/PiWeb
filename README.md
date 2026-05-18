# PiWeb

[![CI](https://github.com/myshytf/PiWeb/actions/workflows/ci.yml/badge.svg)](https://github.com/myshytf/PiWeb/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](package.json)

A standalone, mobile-friendly web interface for the [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It runs an HTTP + WebSocket server, serves a static Next.js UI, and lets you drive pi sessions from a browser.

![pi-web mobile UI](docs/mobile-initial.png)

## Features

- Chat UI for pi agent sessions with real-time streaming over WebSocket.
- Session list, switching, new sessions, and background-session status updates.
- File browser and workspace tools for the active project.
- Model/thinking settings, slash-command bridge, and token-usage display.
- PWA assets and optional Web Push notifications for completed work.
- Built-in auth, same-origin API protections, request-size limits, and file-root restrictions.

## Quick start from source

```bash
git clone https://github.com/myshytf/PiWeb.git
cd PiWeb
npm ci
npm run setup:frontend
npm run build
npm start -- --cwd /path/to/your/project
```

Open the URL printed by the server, usually `http://localhost:9876`.

On first run, pi-web creates a credentials file at `~/.pi/agent/pi-web-credentials.json` and prints the generated password once. You can also set your own credentials:

```bash
PI_WEB_USERNAME=piweb PI_WEB_PASSWORD='use-a-long-random-secret' npm start -- --cwd .
```

## Install as a CLI package

Install the scoped npm package:

```bash
npm install -g @minyongchoi94/pi-web
pi-web --cwd /path/to/your/project
```

Or run without global install:

```bash
npx @minyongchoi94/pi-web --cwd /path/to/your/project
```

The unscoped `pi-web` npm name is already taken by another maintainer, so this project is published under the `@minyongchoi94` scope.

## CLI options

```bash
pi-web --help
```

| Option | Env var | Default | Description |
| --- | --- | --- | --- |
| `--port` | `PI_WEB_PORT` | `9876` | HTTP/WebSocket port. |
| `--host` | `PI_WEB_HOST` | `0.0.0.0` | Bind host. Use `127.0.0.1` for local-only access. |
| `--cwd` | `PI_WEB_CWD` | current directory | Project directory for pi sessions. |
| `--agent-dir` | `PI_WEB_AGENT_DIR` | `~/.pi/agent` | pi agent config/session directory. |
| `--username` | `PI_WEB_USERNAME` | `piweb` | Login username. |
| `--password` | `PI_WEB_PASSWORD` | generated | Login password. |
| `--no-auth` | `PI_WEB_NO_AUTH=1` | auth enabled | Disable auth. Only use on trusted networks. |
| `--https` | — | off | Serve HTTPS with mkcert files in `~/.pi/certs/`. |

Additional environment variables:

| Env var | Description |
| --- | --- |
| `PI_WEB_CREDENTIALS_FILE` | Override the generated credentials file path. |
| `PI_WEB_ALLOWED_ORIGINS` | Comma-separated extra origins allowed by API CORS. |
| `PI_WEB_ALLOWED_ROOTS` | Comma-separated filesystem roots allowed by file APIs. |
| `PI_WEB_TRUST_PROXY=1` | Trust reverse-proxy IP headers for auth rate limiting. |
| `PI_WEB_COOKIE_SECURE=1` | Force the auth cookie `Secure` flag behind HTTPS proxies. |
| `PI_WEB_VAPID_SUBJECT` | Web Push VAPID subject, e.g. `mailto:you@example.com`. |

Copy `.env.example` if you want a local template.

## Remote/LAN access

For phone or tablet access on the same network:

```bash
PI_WEB_PASSWORD='use-a-long-random-secret' pi-web --host 0.0.0.0 --port 9876 --cwd .
```

Security notes:

- Keep auth enabled.
- Use HTTPS, a trusted tunnel, or a reverse proxy for internet access.
- Set `PI_WEB_ALLOWED_ROOTS` if you want to limit filesystem access.
- Never commit `.env`, credential JSON, TLS keys, push subscriptions, or pi session state.

## Development

```bash
npm ci
npm run setup:frontend
npm run dev          # backend on :9876
npm run dev:frontend # Next dev server with API/WS rewrites
```

Useful checks:

```bash
npm run typecheck
npm run build
npm run pack:dry-run
npm run release:check
```

E2E tests need a running server:

```bash
npm run test:server
npm run test:e2e
```

## Package contents

The npm package is intentionally small. `package.json#files` publishes only:

- `dist/` TypeScript build output
- `frontend/out/` static UI export
- README, license, changelog, security/contributing docs, and the README screenshot

The full source code, tests, and design notes are distributed through GitHub.

## API overview

- `GET /api/health`
- `GET /api/sessions`, `POST /api/sessions/new`, `POST /api/sessions/switch`
- `GET /api/messages`, `POST /api/messages/prompt`, `POST /api/messages/abort`
- `GET /api/settings`, `POST /api/settings/model`, `POST /api/settings/thinking`
- `GET /api/files/list`, `GET /api/files/read`, `POST /api/files/write`
- `GET /api/tools`, `GET /api/agent/state`
- `GET /api/events/stream` and `WS /ws`
- `GET/POST /api/push/*` for Web Push setup

## Publishing

See [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for the GitHub and npm release checklist. Short version:

```bash
npm ci
npm run setup:frontend
npm run release:check
git init -b main
git add .
git commit -m "Initial open-source release"
gh repo create myshytf/PiWeb --public --source=. --remote=origin --push
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security guidance is in [`SECURITY.md`](SECURITY.md).

## License

MIT © 2026 Dylan Choi

---

🇰🇷 [한국어 문서 보기](README.ko.md)
