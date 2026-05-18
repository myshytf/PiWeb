"use client";

import { useMemo } from "react";
import { useAppStore } from "@/stores/app-store";
import { FolderOpen, List } from "lucide-react";

interface RecentDir {
  cwd: string;
  dirName: string;
}

interface RecentDirsProps {
  selectedCwd: string | null;
  onSelect: (cwd: string | null) => void;
}

export function RecentDirs({ selectedCwd, onSelect }: RecentDirsProps) {
  const store = useAppStore();

  const recentDirs = useMemo<RecentDir[]>(() => {
    const dirMap = new Map<string, number>();
    for (const s of store.sessions) {
      if (s.cwd) {
        const existing = dirMap.get(s.cwd) ?? 0;
        if ((s.updatedAt ?? 0) > existing) {
          dirMap.set(s.cwd, s.updatedAt ?? 0);
        }
      }
    }
    return Array.from(dirMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cwd]) => ({
        cwd,
        dirName: cwd.split("/").filter(Boolean).pop() || cwd,
      }));
  }, [store.sessions]);

  if (recentDirs.length === 0) return null;

  return (
    <div className="mb-2">
      <div className="text-[10px] text-[var(--color-text-muted)] mb-1.5 px-1">
        Directories
      </div>
      <div className="flex flex-wrap gap-1">
        {/* All button */}
        <button
          onClick={() => onSelect(null)}
          title="Show all sessions"
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
            selectedCwd === null
              ? "bg-[var(--color-accent)] text-white border border-[var(--color-accent)]"
              : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
          }`}
        >
          <List size={10} className="flex-shrink-0" />
          All
        </button>

        {/* Directory chips */}
        {recentDirs.map((dir) => {
          const isActive = selectedCwd === dir.cwd;
          return (
            <button
              key={dir.cwd}
              onClick={() => onSelect(isActive ? null : dir.cwd)}
              title={dir.cwd}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                isActive
                  ? "bg-[var(--color-accent)] text-white border border-[var(--color-accent)]"
                  : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
              }`}
            >
              <FolderOpen size={10} className="flex-shrink-0" />
              <span className="truncate max-w-[120px]">{dir.dirName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
