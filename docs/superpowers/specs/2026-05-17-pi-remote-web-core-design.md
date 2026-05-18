# Pi Remote Web Core Design

**Goal:** Make `pi-web-remote` a practical mobile-first web UI for controlling pi remotely, using the SDK-backed architecture already in the project and borrowing proven UX patterns from the opencode app.

## Approved Approach

Use the existing standalone Hono + WebSocket backend and Next/React frontend. Do not introduce tmux, PTY mirroring, a browser shell, multi-user auth, or a large framework migration in this phase. The web UI should become a stable SDK-first remote app: the server owns long-running agent work, while the browser can disconnect, reconnect, and recover state.

## Architecture

The backend keeps the current `PiWebApp` runtime ownership model. `POST /api/messages/prompt` remains fire-and-forget so prompt execution is not tied to an HTTP request or browser connection. WebSocket events remain the live update channel, and REST endpoints remain the recovery source after reconnect, reload, or mobile foregrounding.

The frontend is reorganized around a session workspace shell:

```txt
frontend/src/app/page.tsx
  └─ SessionShell
      ├─ SessionSidebar
      ├─ MessageTimeline
      ├─ ComposerDock
      └─ WorkspacePanel
```

`app-store.ts` remains the source of truth for this phase. State helpers can be extracted only when they reduce risk in files being changed.

## Components

- `SessionShell`: owns responsive layout, desktop split panes, mobile overlays, top bar, status bar placement, and connection/session metadata display.
- `MessageTimeline`: renders empty state, user messages, assistant messages, pending follow-ups, and the scroll anchor.
- `ComposerDock`: owns prompt input, send/abort controls, queued follow-up display, selected file context chips, and mobile-safe bottom spacing.
- `WorkspacePanel`: owns file browser, selected file preview, current cwd/session/model status, and file-to-prompt context actions.
- `FileBrowser`: continues listing and reading files, but exposes an action for adding the selected file to prompt context.

## Data Flow

```txt
SDK events → src/agent-events.ts → WebSocket → app-store.ts → SessionShell children
REST endpoints → app-store.ts → recovery and initial load
File selection → app-store.ts selectedFileContexts → ComposerDock prompt text
```

Selected files are represented as lightweight context chips in frontend state. In this phase, sending a prompt with selected files prepends a deterministic text block containing file paths and file contents to the prompt. This avoids backend protocol changes while giving the agent real file context. Large file contents already read by the UI are limited before insertion.

## Included Scope

1. Responsive session shell with desktop sidebar/timeline/workspace and mobile drawer/overlay behavior.
2. Timeline extraction and clearer rendering of messages, streaming placeholder, thinking, and tool cards.
3. Composer dock with abort, queued follow-up indicator, and file context chips.
4. Workspace panel with cwd/session/model state and file browser/preview/context action.
5. Reliability preservation: prompt remains independent of client request lifetime; reconnect reload continues to restore messages and streaming state.
6. Playwright coverage for mobile overflow, workspace opening, file context chip insertion/removal, and composer behavior.

## Excluded Scope

- tmux/PTY terminal mirroring.
- Browser shell terminal.
- Multi-agent orchestration UI.
- Image attachment.
- Drag-and-drop upload.
- Advanced patch review/editor flows.
- OAuth, reverse proxy, or multi-user deployment work.

## Testing and Completion Criteria

Required verification before declaring completion:

```bash
npx tsc --noEmit
npm run build:frontend
npx playwright test --reporter=line
```

Completion criteria:

- Mobile viewport does not horizontally overflow.
- Desktop shows sessions, timeline, and workspace as distinct usable regions.
- Mobile can open/close session drawer and workspace overlay.
- Prompt input works with selected file context chips.
- Streaming/abort UI remains visible and reconnect recovery is not regressed.
- Existing API/session/recovery tests continue to pass.

## Self-Review

- Placeholder scan: no TBD/TODO placeholders remain.
- Consistency: architecture, scope, and test criteria all use the SDK-first web approach.
- Scope: focused on one implementation phase; tmux and auth are explicitly excluded.
- Ambiguity: file context behavior is explicit: frontend prepends path/content blocks to the prompt in this phase.
