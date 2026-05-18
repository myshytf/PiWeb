# Security Policy

pi-web exposes a local coding-agent control surface over HTTP and WebSocket. Treat it like a remote shell for your development machine.

## Supported versions

Security fixes are provided for the latest released version.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories once the repository is published. If advisories are not enabled yet, open a minimal issue asking for a private disclosure channel without posting exploit details.

## Deployment guidance

- Keep authentication enabled unless you are on an isolated, trusted network.
- Set `PI_WEB_PASSWORD` to a long random secret or use the generated credentials file.
- Prefer HTTPS or a trusted tunnel/reverse proxy for access outside localhost/LAN.
- Use `PI_WEB_ALLOWED_ROOTS` to restrict file-browser and write access.
- Do not commit `.env`, credential files, TLS private keys, push subscriptions, or pi session state.
