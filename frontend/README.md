# pi-web frontend

This directory contains the Next.js UI that is statically exported and served by the pi-web backend.

## Development

From the repository root:

```bash
npm run setup:frontend
npm run dev          # backend API on :9876
npm run dev:frontend # Next dev server with API/WS rewrites
```

## Build

```bash
npm run build:frontend
```

The static export is written to `frontend/out/` and included in the npm package alongside `dist/`.
