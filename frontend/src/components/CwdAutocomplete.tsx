"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { FolderOpen } from "lucide-react";

interface CwdAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

interface Suggestion {
  name: string;
  parentDisplay: string;
}

export function CwdAutocomplete({ value, onChange, onSubmit, onClose }: CwdAutocompleteProps) {
  const store = useAppStore();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  /**
   * Parse the current input into an API path and prefix for matching.
   * Returns { apiPath, parentDisplay, prefix }.
   * - apiPath: the directory to list (or null if autocomplete should be skipped)
   * - parentDisplay: parent path for display purposes (no trailing slash)
   * - prefix: the current partial directory name to match against
   */
  const parseInput = useCallback((input: string): {
    apiPath: string | null;
    parentDisplay: string;
    prefix: string;
  } => {
    if (!input || input === "") {
      return { apiPath: null, parentDisplay: "", prefix: "" };
    }

    // Skip autocomplete for ~ paths (backend expands ~ on submit)
    if (input.startsWith("~")) {
      return { apiPath: null, parentDisplay: "", prefix: "" };
    }

    let resolvedInput = input;
    const cwd = store.cwd || "";

    // Resolve relative paths against current cwd
    if (!input.startsWith("/") && cwd) {
      resolvedInput = cwd.endsWith("/") ? cwd + input : cwd + "/" + input;
    }

    // Trailing slash: list the directory itself
    if (resolvedInput.endsWith("/")) {
      return {
        apiPath: resolvedInput,
        parentDisplay: resolvedInput.replace(/\/$/, ""),
        prefix: "",
      };
    }

    const lastSlash = resolvedInput.lastIndexOf("/");
    if (lastSlash >= 0) {
      return {
        apiPath: resolvedInput.slice(0, lastSlash + 1),
        parentDisplay: resolvedInput.slice(0, lastSlash),
        prefix: resolvedInput.slice(lastSlash + 1),
      };
    }

    // No slash found (shouldn't happen for resolved paths, but safety)
    return { apiPath: null, parentDisplay: "", prefix: "" };
  }, [store.cwd]);

  // Fetch suggestions with debounce
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const { apiPath, prefix } = parseInput(value);

    if (!apiPath) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    const thisRequestId = ++requestIdRef.current;

    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.listFiles(apiPath);
        // Guard against stale responses from previous requests
        if (thisRequestId !== requestIdRef.current) return;
        const dirs = result.entries
          .filter((e) => e.type === "directory")
          .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase()))
          .slice(0, 20)
          .map((e) => ({
            name: e.name,
            parentDisplay: apiPath === "/" ? "/" : apiPath!.replace(/\/$/, ""),
          }));
        setSuggestions(dirs);
        setIsOpen(dirs.length > 0);
        setHighlightIndex(-1);
      } catch {
        if (thisRequestId !== requestIdRef.current) return;
        setSuggestions([]);
        setIsOpen(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, parseInput]);

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit(value);
        onClose();
      } else if (e.key === "Escape") {
        onClose();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
          // Fill input with selected directory + trailing slash
          const selected = suggestions[highlightIndex];
          onChange(
            (selected.parentDisplay.endsWith("/")
              ? selected.parentDisplay
              : selected.parentDisplay + "/") + selected.name + "/",
          );
          setIsOpen(false); // Close dropdown until new API call completes
          inputRef.current?.focus();
        } else {
          onSubmit(value);
          onClose();
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setHighlightIndex(-1);
        break;
      case "Tab":
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
          const selected = suggestions[highlightIndex];
          onChange(
            (selected.parentDisplay.endsWith("/")
              ? selected.parentDisplay
              : selected.parentDisplay + "/") + selected.name + "/",
          );
          setIsOpen(false);
        }
        break;
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex < 0 || !containerRef.current) return;
    const items = containerRef.current.querySelectorAll("[data-suggestion-index]");
    const highlighted = items[highlightIndex] as HTMLElement | undefined;
    highlighted?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  return (
    <div ref={containerRef} className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/path/to/project"
        className="w-full px-2 py-1 text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
        onKeyDown={handleKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {isOpen && suggestions.length > 0 && (
        <div
          className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded shadow-lg"
          style={{ scrollbarWidth: "thin", scrollbarColor: "var(--color-bg-hover) transparent" }}
        >
          {suggestions.map((s, i) => (
            <div
              key={s.name}
              data-suggestion-index={i}
              className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer text-xs transition-colors ${
                i === highlightIndex
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(
                  (s.parentDisplay.endsWith("/")
                    ? s.parentDisplay
                    : s.parentDisplay + "/") + s.name + "/",
                );
                setIsOpen(false);
                inputRef.current?.focus();
              }}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <FolderOpen size={12} className="flex-shrink-0" />
              <span className="truncate flex-1">{s.name}</span>
              <span
                className={`text-[10px] flex-shrink-0 ${
                  i === highlightIndex ? "text-white/60" : "text-[var(--color-text-muted)]"
                }`}
              >
                {s.parentDisplay}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
