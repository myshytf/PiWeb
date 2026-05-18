# Contributing to pi-web

Thanks for helping improve pi-web.

## Local setup

```bash
npm ci
npm run setup:frontend
npm run build
npm start -- --cwd /path/to/a/project
```

For frontend-only development:

```bash
npm run dev          # backend on :9876
npm run dev:frontend # Next dev server on :3000 with API rewrites
```

## Quality checks

Before opening a pull request, run:

```bash
npm run typecheck
npm run build
npm run pack:dry-run
```

End-to-end tests require a running test server or pi-web instance:

```bash
npm run test:server
npm run test:e2e
```

## Pull request guidelines

- Keep changes focused and explain the user-facing impact.
- Include screenshots or short recordings for UI changes.
- Update `README.md` when commands, options, or setup steps change.
- Avoid committing generated artifacts such as `node_modules`, `dist`, `frontend/out`, `.next`, logs, credentials, or local pi state.
