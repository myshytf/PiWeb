# Web UI Request Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show headless pi extension UI requests (select/confirm/input/editor/notify) in the pi-web composer dock and send the user's answer back to the waiting SDK promise.

**Architecture:** Add a backend `WebUIBridge` that implements the SDK `ExtensionUIContext`, stores pending requests, broadcasts `ui_request` events over WebSocket, and exposes REST endpoints to list/respond/cancel pending requests. Bind this UI context to every current and replacement `AgentSession`. On the frontend, normalize `ui_request` events into Zustand state and render an interaction dock above the composer.

**Tech Stack:** TypeScript, Hono, WebSocket, `@earendil-works/pi-coding-agent` SDK, Next.js/React, Zustand, Playwright.

---

## File Structure

- Create: `src/web-ui-bridge.ts`
  - Owns pending select/confirm/input/editor requests, notify broadcasts, response resolution, timeout handling, and WebSocket broadcast hooks. Other TUI-only UI methods are safe no-ops in this phase.
- Create: `src/routes/ui.ts`
  - Provides `GET /api/ui/pending`, `POST /api/ui/respond`, and `POST /api/ui/cancel`.
- Modify: `src/routes/index.ts`
  - Registers UI routes.
- Modify: `src/app.ts`
  - Creates one `WebUIBridge`, binds its UI context to initial/replaced sessions, and replays pending requests on WS connect.
- Modify: `frontend/src/lib/api.ts`
  - Adds UI request/response types and API helpers.
- Modify: `frontend/src/stores/app-store.ts`
  - Adds `pendingUiRequests`, `handleWsEvent("ui_request")`, pending reload, response actions.
- Create: `frontend/src/components/InteractionDock.tsx`
  - Renders select/confirm/input/notify requests with accessible controls.
- Modify: `frontend/src/components/ComposerDock.tsx`
  - Displays `InteractionDock` above file context chips/input.
- Create/Modify tests in `e2e/`.

## Task 1: Backend Bridge and Routes

- [ ] **Step 1: Write failing backend tests**

Create `e2e/ui-bridge-unit.spec.ts` with tests for:
- `uiContext.select()` broadcasts a `ui_request`, appears in `GET /api/ui/pending`, and resolves when `POST /api/ui/respond` sends `{ value }`.
- `uiContext.confirm()` resolves when `POST /api/ui/respond` sends `{ confirmed }`.
- `POST /api/ui/cancel` resolves the request as cancelled/default.

- [ ] **Step 2: Run backend bridge tests and verify failure**

Run: `npx playwright test e2e/ui-bridge-unit.spec.ts --reporter=line`

Expected: FAIL because `src/web-ui-bridge.ts` and `/api/ui/*` routes do not exist.

- [ ] **Step 3: Implement `WebUIBridge`**

Implement pending request storage, broadcast shape, `getPendingRequests()`, `respond()`, `cancel()`, and SDK `uiContext` methods.

- [ ] **Step 4: Implement UI routes and register them**

Register `GET /api/ui/pending`, `POST /api/ui/respond`, and `POST /api/ui/cancel`.

- [ ] **Step 5: Run backend bridge tests**

Run: `npx playwright test e2e/ui-bridge-unit.spec.ts --reporter=line`

Expected: PASS.

## Task 2: Bind Bridge to Sessions

- [ ] **Step 1: Add session binding test**

Extend unit coverage or app-level assertions so initial session and replacement session both call `bindExtensions({ uiContext })`.

- [ ] **Step 2: Implement binding in `src/app.ts`**

Create `this.uiBridge` during startup, bind it to `this.session`, bind it again inside `runtime.setRebindSession`, and replay pending requests to newly connected WS clients.

- [ ] **Step 3: Run route/session unit tests**

Run: `npx playwright test e2e/ui-bridge-unit.spec.ts e2e/session-routes-unit.spec.ts --reporter=line`

Expected: PASS.

## Task 3: Frontend Interaction Dock

- [ ] **Step 1: Write failing frontend tests**

Add E2E tests that mock `/api/ui/pending`, emit/respond through real API routes, and assert:
- A select request displays title/options and posts the clicked value.
- A confirm request displays confirm/cancel controls.
- An input request displays a textbox and submits typed value.

- [ ] **Step 2: Run frontend tests and verify failure**

Run: `npx playwright test e2e/pi-web-remote.spec.ts --grep "interaction dock" --reporter=line`

Expected: FAIL because the dock does not exist.

- [ ] **Step 3: Add API/store support**

Add `UiRequest` types, `api.pendingUiRequests()`, `api.respondUiRequest()`, and `api.cancelUiRequest()`. Store pending requests and respond/cancel actions in Zustand.

- [ ] **Step 4: Implement `InteractionDock`**

Render one request at a time above the composer. Use an industrial/minimal dark style matching pi-web. All buttons/input controls must have accessible labels.

- [ ] **Step 5: Run frontend interaction tests**

Run: `npx playwright test e2e/pi-web-remote.spec.ts --grep "interaction dock" --reporter=line`

Expected: PASS.

## Task 4: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 2: Build frontend**

Run: `npm run build:frontend`

Expected: PASS, with only existing Next static export warnings.

- [ ] **Step 3: Run full Playwright suite**

Run: `npx playwright test --reporter=line`

Expected: PASS.

## Plan Self-Review

- Spec coverage: covers SDK UI context, backend route, WS replay, frontend dock, and tests.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `WebUIBridge`, `UiRequest`, `ui_request`, `/api/ui/respond`, and `/api/ui/cancel` are used consistently.
