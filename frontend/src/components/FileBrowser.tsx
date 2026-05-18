"use client";

import { useAppStore } from "@/stores/app-store";
import { Folder, File, ChevronRight, ChevronDown, X } from "lucide-react";
import { useState } from "react";

export function FileBrowser() {
  const store = useAppStore();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleFileClick = async (path: string) => {
    await store.readFile(path);
  };

  const handleDirClick = async (path: string) => {
    toggleDir(path);
    await store.listFiles(path);
  };

  const goUp = () => {
    const parent = store.fileBrowserPath.split("/").slice(0, -1).join("/") || "/";
    store.listFiles(parent);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-border)]">
        <h3 className="text-xs font-semibold text-[var(--color-text-primary)]">Files</h3>
        <button
          onClick={() => store.setFileBrowserOpen(false)}
          aria-label="Close file browser"
          className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] touch-manipulation"
        >
          <X size={16} className="text-[var(--color-text-muted)]" />
        </button>
      </div>

      {/* Path breadcrumb */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text-muted)] overflow-x-auto">
        <button onClick={() => store.listFiles("/")} className="hover:text-[var(--color-text-primary)]">/</button>
        {store.fileBrowserPath && store.fileBrowserPath !== "/" &&
          store.fileBrowserPath.split("/").filter(Boolean).map((part, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={8} />
              <button
                onClick={() => store.listFiles("/" + arr.slice(0, i + 1).join("/"))}
                className="hover:text-[var(--color-text-primary)]"
              >
                {part}
              </button>
            </span>
          ))
        }
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {store.fileBrowserPath !== "/" && (
          <button
            onClick={goUp}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] border-b border-[var(--color-border)]"
          >
            ← ..
          </button>
        )}
        {store.fileBrowserEntries
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map((entry) => (
            <button
              type="button"
               key={entry.path}
              className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] border-b border-[var(--color-border)]"
              onClick={() => entry.type === "directory" ? handleDirClick(entry.path) : handleFileClick(entry.path)}
            >
              {entry.type === "directory" ? (
                <Folder size={12} className="text-[var(--color-yellow)]" />
              ) : (
                <File size={12} className="text-[var(--color-text-muted)]" />
              )}
              <span className="text-[var(--color-text-primary)] truncate">{entry.name}</span>
              {entry.type === "file" && (
                <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                  {formatSize(entry.size)}
                </span>
              )}
            </button>
          ))}
      </div>

      {/* File content viewer */}
      {store.fileContent && (
        <div className="border-t border-[var(--color-border)] flex flex-col" style={{ height: "40%" }}>
          <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)]">
            <span className="text-[10px] text-[var(--color-text-muted)] truncate">
              {store.fileContentPath}
            </span>
            <button
              onClick={() => useAppStore.setState({ fileContent: null, fileContentPath: null })}
              aria-label="Close file preview"
              className="p-0.5 rounded hover:bg-[var(--color-bg-hover)]"
            >
              <X size={10} className="text-[var(--color-text-muted)]" />
            </button>
          </div>
          <pre className="flex-1 overflow-auto p-2 text-[10px] font-mono text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)]">
            {store.fileContent.length > 50000
              ? store.fileContent.slice(0, 50000) + "\n... (truncated)"
              : store.fileContent}
          </pre>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
