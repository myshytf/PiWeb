# Pi Remote Web Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first SDK-first, mobile-friendly pi remote web workspace with separated session shell, timeline, composer dock, workspace panel, and file context chips.

**Architecture:** Keep the existing Hono/WebSocket backend and Zustand frontend state. Split the current `page.tsx`/`ChatPanel.tsx` responsibilities into focused React components while preserving the fire-and-forget prompt and reconnect recovery behavior. File context is implemented in frontend state by prepending deterministic file blocks to the outgoing prompt.

**Tech Stack:** Next.js 16 static export, React 19, Zustand 5, Tailwind CSS 4, Hono, WebSocket, Playwright.

---

## File Structure

- Modify: `frontend/src/stores/app-store.ts`
  - Add selected file context state and actions.
  - Make `sendPrompt()` include selected file context text.
- Create: `frontend/src/components/MessageTimeline.tsx`
  - Extract message list and empty state from `ChatPanel`.
- Create: `frontend/src/components/ComposerDock.tsx`
  - Extract prompt textarea, send/abort controls, pending follow-ups, and context chips from `ChatPanel`.
- Create: `frontend/src/components/WorkspacePanel.tsx`
  - Combine session metadata, selected file preview, file context action, and `FileBrowser`.
- Modify: `frontend/src/components/ChatPanel.tsx`
  - Reduce to a container composing `MessageTimeline` and `ComposerDock`.
- Modify: `frontend/src/components/FileBrowser.tsx`
  - Add touch-friendly file rows and context-aware preview behavior; keep list/read APIs unchanged.
- Modify: `frontend/src/app/page.tsx`
  - Use `WorkspacePanel` instead of directly rendering `FileBrowser`.
- Modify: `e2e/pi-web-remote.spec.ts`
  - Add coverage for workspace panel, file context chip add/remove, and mobile overflow after the shell split.

## Task 1: Add File Context State

**Files:**
- Modify: `frontend/src/stores/app-store.ts`
- Test: `e2e/pi-web-remote.spec.ts`

- [ ] **Step 1: Write the failing E2E expectation**

Add a test under `test.describe("Frontend UI", ...)` that opens the file browser, selects `README.md`, adds it as context, verifies a chip appears, removes it, and verifies it disappears.

```ts
test("can add and remove a selected file as prompt context", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("connected").last()).toBeVisible({ timeout: 15000 });
  await page.locator('button[title="File browser"]').click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await page.getByText("README.md", { exact: true }).click();
  await page.getByRole("button", { name: "Add file to prompt context" }).click();
  await expect(page.getByText("README.md").last()).toBeVisible();
  await page.getByRole("button", { name: /Remove context README\.md/ }).click();
  await expect(page.getByRole("button", { name: /Remove context README\.md/ })).toHaveCount(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/pi-web-remote.spec.ts --grep "can add and remove a selected file as prompt context" --reporter=line`

Expected: FAIL because `Workspace` heading and context button do not exist yet.

- [ ] **Step 3: Implement state**

Add to `app-store.ts`:

```ts
export interface FileContextItem {
  path: string;
  name: string;
  content: string;
  size: number;
}

selectedFileContexts: FileContextItem[];
addSelectedFileToContext: () => void;
removeFileContext: (path: string) => void;
clearFileContexts: () => void;
```

Initialize `selectedFileContexts: []`. Implement `addSelectedFileToContext()` using `fileContentPath` and `fileContent`, deduping by path and limiting stored content to 20000 characters. Implement `removeFileContext()` and `clearFileContexts()` with simple filters.

- [ ] **Step 4: Run typecheck for state**

Run: `npx tsc --noEmit`

Expected: PASS.

## Task 2: Split Timeline and Composer

**Files:**
- Create: `frontend/src/components/MessageTimeline.tsx`
- Create: `frontend/src/components/ComposerDock.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`

- [ ] **Step 1: Create `MessageTimeline.tsx`**

Move message rendering and empty state from `ChatPanel` into `MessageTimeline`, keeping the auto-scroll behavior.

- [ ] **Step 2: Create `ComposerDock.tsx`**

Move textarea/send/abort controls from `ChatPanel` into `ComposerDock`. Render context chips above the textarea:

```tsx
{store.selectedFileContexts.map((ctx) => (
  <span key={ctx.path}>{ctx.name}</span>
))}
```

Each chip has an accessible remove button named `Remove context ${ctx.name}`.

- [ ] **Step 3: Reduce `ChatPanel.tsx`**

Replace local message/input code with:

```tsx
export function ChatPanel() {
  return (
    <div className="flex flex-col h-full">
      <MessageTimeline />
      <ComposerDock />
    </div>
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`

Expected: PASS.

## Task 3: Add Workspace Panel

**Files:**
- Create: `frontend/src/components/WorkspacePanel.tsx`
- Modify: `frontend/src/app/page.tsx`
- Modify: `frontend/src/components/FileBrowser.tsx`

- [ ] **Step 1: Create `WorkspacePanel.tsx`**

Render a `Workspace` heading, cwd/model/session status, add-file-context button when a file is selected, file preview summary, and `FileBrowser`.

- [ ] **Step 2: Replace direct `FileBrowser` usage**

In `page.tsx`, render `<WorkspacePanel />` in the desktop side pane and mobile full-screen overlay.

- [ ] **Step 3: Keep file browser close behavior**

Ensure the `FileBrowser` close button still calls `store.setFileBrowserOpen(false)` and remains visible in mobile overlay.

- [ ] **Step 4: Run targeted UI tests**

Run: `npx playwright test e2e/pi-web-remote.spec.ts --grep "file browser can be toggled|can add and remove a selected file as prompt context" --reporter=line`

Expected: PASS.

## Task 4: Include File Context in Prompts

**Files:**
- Modify: `frontend/src/stores/app-store.ts`
- Modify: `frontend/src/components/ComposerDock.tsx`

- [ ] **Step 1: Build outgoing prompt text**

Add a helper in `app-store.ts`:

```ts
function buildPromptWithFileContexts(text: string, contexts: FileContextItem[]): string {
  if (contexts.length === 0) return text;
  const blocks = contexts.map((ctx) => {
    const content = ctx.content.length > 20000 ? `${ctx.content.slice(0, 20000)}\n... (truncated)` : ctx.content;
    return `<file path="${ctx.path}">\n${content}\n</file>`;
  });
  return `${blocks.join("\n\n")}\n\nUser request:\n${text}`;
}
```

Use this when calling `api.sendPrompt()` but keep the visible local user message as the user's original text.

- [ ] **Step 2: Clear contexts after a sent prompt**

After `api.sendPrompt()` succeeds, call `set({ selectedFileContexts: [] })`.

- [ ] **Step 3: Preserve contexts on failed send**

In the `catch`, do not clear `selectedFileContexts`.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`

Expected: PASS.

## Task 5: Mobile and Regression Coverage

**Files:**
- Modify: `e2e/pi-web-remote.spec.ts`

- [ ] **Step 1: Add mobile workspace overlay test**

Add a test that sets viewport to 375x812, opens workspace, verifies no horizontal overflow, closes it, and verifies the textarea remains visible.

- [ ] **Step 2: Run the mobile tests**

Run: `npx playwright test e2e/pi-web-remote.spec.ts --grep "mobile" --reporter=line`

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
npx tsc --noEmit
npm run build:frontend
npx playwright test --reporter=line
```

Expected: all commands PASS.

## Plan Self-Review

- Spec coverage: session shell, timeline, composer, workspace, file context, and recovery preservation are covered.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `FileContextItem`, `selectedFileContexts`, `addSelectedFileToContext`, `removeFileContext`, and `clearFileContexts` are consistently named.
