# Recent Directories Shortcuts Design

## Summary

Add a "Recent Directories" section to the sidebar showing the most recently used working directories as clickable shortcut chips. Clicking a chip creates a new session in that directory, providing quick switching between projects.

## Data Source

No backend changes. Extracts unique `cwd` values from `store.sessions` (already loaded and sorted by `updatedAt` descending).

**Deduplication logic:**
1. Iterate `store.sessions`, build `Map<cwd, max(updatedAt)>`
2. Sort entries by `updatedAt` descending
3. Take top 7
4. Display the last path segment as the chip label

## UI Placement

```
┌─ Sidebar Header ────────────────────┐
│ Sessions                 [+] [📁]   │
├─────────────────────────────────────┤
│ [/path/to/project _______] [Create] │  ← CwdAutocomplete
├─────────────────────────────────────┤
│ Recent Directories                  │  ← NEW section
│ [pi-coding] [pi-web-remote] [docs] │
├─────────────────────────────────────┤
│ 🔍 Search sessions...               │
├─────────────────────────────────────┤
│ Session list...                     │
└─────────────────────────────────────┘
```

## Component: `RecentDirs`

- No props — reads directly from `useAppStore()`
- Uses `useMemo` to compute deduplicated CWDs from `store.sessions`
- Returns `null` if 0 directories (no sessions yet)
- Each chip: `FolderOpen` icon + directory name (truncated to ~100px)
- Active cwd chip: accent border/background, disabled click
- Inactive chip: tertiary background, hover effect
- Full path shown as `title` tooltip

## Interaction

| Action | Result |
|---|---|
| Click inactive chip | `store.createNewSessionWithCwd(dir.cwd)` |
| Click active chip | No-op (disabled) |
| Directory deleted | API returns 404, handled silently |

## Files Changed

1. **New:** `frontend/src/components/RecentDirs.tsx` — the shortcuts component
2. **Modified:** `frontend/src/components/Sidebar.tsx` — add `<RecentDirs>` between CwdAutocomplete and search
