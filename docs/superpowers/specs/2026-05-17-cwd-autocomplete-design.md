# CWD Path Autocomplete Design

## Summary

Add real-time directory path autocomplete to the "New session from folder" input in the sidebar. As the user types a directory path, matching subdirectories appear in a dropdown below the input for click or keyboard selection.

## Current State

The sidebar has a "New session from folder" button that toggles a plain `<input>` element. The user types a full path and presses Enter or clicks Create. No autocomplete or suggestion support exists.

## Design

### Component: `CwdAutocomplete`

A self-contained component replacing the current plain `<input>` in `Sidebar.tsx`.

**Props:**
- `value: string` — current input value
- `onChange: (value: string) => void` — input value change
- `onSubmit: (value: string) => void` — final submission (Enter without selection)
- `onClose: () => void` — close/hide the input

**Internal state:**
- `suggestions: string[]` — directory names matching the current prefix
- `highlightIndex: number` — keyboard navigation index
- `isOpen: boolean` — dropdown visibility

### Path Parsing Logic

| User input | Parent path (API target) | Match prefix |
|---|---|---|
| `/Users/do` | `/Users/` | `do` |
| `/Users/` | `/Users/` | _(empty — show all)_ |
| `/Users` | `/` | `Users` |
| `/` | `/` | _(empty — show all)_ |
| `~/proj` | _(skip autocomplete)_ | — |
| `src/comp` | `{cwd}/src/` | `comp` |

### Data Flow

```
User types → debounce 250ms → parsePath()
  → GET /api/files/list?path=<parent>
  → filter entries where type === "directory"
  → filter names matching prefix (case-insensitive)
  → show dropdown (max 20 items)
```

Uses existing `api.listFiles()` from `api.ts`. No backend changes needed.

### Interaction

- **Typing:** debounced API call, dropdown appears with matching directories
- **Arrow Down/Up:** navigate suggestions (wraps at boundaries)
- **Enter (with selection):** fill input with `<parent><selected>/`, dropdown refreshes for next level
- **Enter (no selection):** submit the path (create session with current cwd)
- **Escape:** close dropdown (keep input value)
- **Tab:** same as Enter with selection
- **Click:** same as Enter with selection
- **Click outside:** close dropdown

### UI

Each dropdown item: folder icon + directory name + parent path (small, muted). Styled using existing CSS custom properties (`--color-bg-tertiary`, `--color-border`, etc.). Dark theme compliant by default.

### Edge Cases

- Empty input: no dropdown
- No matching directories: dropdown hidden, no "no results" message
- API error (permission denied, path not found): dropdown hidden silently
- `~` paths: autocomplete skipped (backend handles `~` expansion on submit)
- Very long paths: input scrolls naturally; dropdown items truncate with ellipsis
- Many matches: capped at 20, scrollable

## Files Changed

1. **New:** `frontend/src/components/CwdAutocomplete.tsx` — the autocomplete component
2. **Modified:** `frontend/src/components/Sidebar.tsx` — replace plain `<input>` with `CwdAutocomplete`

## Non-Goals

- No backend changes (uses existing `/api/files/list`)
- No changes to the file browser, composer, or any other component
- No `~` expansion in autocomplete (original path still works on submit)
