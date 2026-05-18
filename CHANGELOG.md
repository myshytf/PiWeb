# Changelog

## 0.3.0

- Added `pi-web setup`, a guided setup wizard for port, credentials, config file, and tunnel autostart.
- Added saved config support via `~/.pi/agent/pi-web-config.json` and `PI_WEB_CONFIG_FILE`.
- Added one-shot public tunnel support with `--tunnel cloudflared` or `--tunnel ngrok`.
- Changed the default bind host to `127.0.0.1` for safer local-only startup.
- Added install-time guidance through a lightweight `postinstall` message.
- Added top-level language selectors to the English and Korean READMEs.

## 0.2.1

- Renamed the npm package to the available scoped name `@minyongchoi94/pi-web`.
- Added maintainer email metadata and cleaned the package binary path for npm.

## 0.2.0

- Prepared the project for open-source release and npm packaging.
- Added portable package metadata, npm publish files, CI release checks, and documentation.
- Replaced the public hardcoded default password with generated credentials.
- Made the configured host option respected by the HTTP/WebSocket server.
- Made the Web Push VAPID subject configurable with `PI_WEB_VAPID_SUBJECT`.
