"use client";

import { useAppStore } from "@/stores/app-store";
import { FileBrowser } from "./FileBrowser";
import { FilePlus2, FolderOpen, Info, PlayCircle } from "lucide-react";

export function WorkspacePanel() {
  const store = useAppStore();
  const selectedName = store.fileContentPath?.split("/").filter(Boolean).pop() ?? null;
  const alreadyAttached = store.fileContentPath
    ? store.selectedFileContexts.some((ctx) => ctx.path === store.fileContentPath)
    : false;
  const canAttach = Boolean(store.fileContentPath && store.fileContent !== null);
  const currentBrowserPath = store.fileBrowserPath || store.cwd || "/";

  const handleStartSessionHere = async () => {
    if (!currentBrowserPath) return;
    await store.createNewSessionWithCwd(currentBrowserPath);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--color-bg-secondary)]">
      <div className="border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FolderOpen size={15} className="text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Workspace</h2>
        </div>
        <div className="mt-2 space-y-1 text-[10px] text-[var(--color-text-muted)]">
          <div className="truncate" title={store.cwd ?? undefined}>cwd: {store.cwd ?? "unknown"}</div>
          <div className="truncate" title={store.sessionFile ?? undefined}>
            session: {store.sessionFile ? store.sessionFile.split("/").pop() : "new"}
          </div>
          <div className="truncate">
            model: {store.currentModel ? `${store.currentModel.provider}/${store.currentModel.name}` : "not selected"}
          </div>
        </div>
        <button
          type="button"
          onClick={handleStartSessionHere}
          title={`Start a new session in ${currentBrowserPath}`}
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-2 py-2 text-xs font-medium text-white hover:opacity-90 active:opacity-80 transition-opacity"
        >
          <PlayCircle size={14} />
          Start session here
        </button>
        <div className="mt-1 truncate text-[10px] text-[var(--color-text-muted)]" title={currentBrowserPath}>
          target: {currentBrowserPath}
        </div>
      </div>

      <div className="border-b border-[var(--color-border)] px-3 py-2">
        {canAttach ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 text-xs">
              <Info size={13} className="mt-0.5 flex-shrink-0 text-[var(--color-text-muted)]" />
              <div className="min-w-0">
                <div className="truncate font-medium text-[var(--color-text-primary)]" title={store.fileContentPath ?? undefined}>
                  {selectedName}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  {store.fileContent?.length ?? 0} chars loaded for preview
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={store.addSelectedFileToContext}
              disabled={alreadyAttached}
              aria-label="Add file to prompt context"
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-2 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] disabled:cursor-default disabled:opacity-50"
            >
              <FilePlus2 size={14} />
              {alreadyAttached ? "File already attached" : "Add file to prompt context"}
            </button>
          </div>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">
            Select a file below to preview it and attach it to your next prompt.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <FileBrowser />
      </div>
    </div>
  );
}
