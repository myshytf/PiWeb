"use client";

import { useMemo, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import type { UiRequest } from "@/lib/api";
import { Bell, Check, Keyboard, ListChecks, X } from "lucide-react";

export function InteractionDock() {
  const requests = useAppStore((state) => state.pendingUiRequests);
  const request = requests[0];

  if (!request) return null;

  return (
    <div className="rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-bg-primary)] shadow-lg overflow-hidden transition-all">
      <div className="flex items-center justify-between px-3.5 py-2 bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-accent)]">
          <span className="flex items-center justify-center w-5 h-5 rounded-md bg-[var(--color-accent)]/10">
            <DockIcon request={request} />
          </span>
          Agent needs input
        </div>
        <span className="text-[10px] text-[var(--color-text-muted)] font-mono">
          {requests.length > 1 ? `${requests.length} pending` : "headless bridge"}
        </span>
      </div>
      <div className="px-3.5 py-3">
        <InteractionRequest request={request} />
      </div>
    </div>
  );
}

function DockIcon({ request }: { request: UiRequest }) {
  if (request.method === "select") return <ListChecks size={13} />;
  if (request.method === "input" || request.method === "editor") return <Keyboard size={13} />;
  if (request.method === "notify") return <Bell size={13} />;
  return <Check size={13} />;
}

function InteractionRequest({ request }: { request: UiRequest }) {
  if (request.method === "select") return <SelectRequest request={request} />;
  if (request.method === "confirm") return <ConfirmRequest request={request} />;
  if (request.method === "input" || request.method === "editor") return <InputRequest request={request} />;
  if (request.method === "notify") return <NotifyRequest request={request} />;
  return null;
}

function SelectRequest({ request }: { request: UiRequest }) {
  const respond = useAppStore((state) => state.respondUiRequest);
  const cancel = useAppStore((state) => state.cancelUiRequest);
  const options = request.options ?? [];

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{request.title ?? "Choose an option"}</h3>
        <p className="mt-1 text-xs text-[var(--color-text-muted)] leading-relaxed">
          {request.message ?? "This prompt came from headless pi. Pick one option to continue the agent run."}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option, index) => (
          <button
            key={`${option}-${index}`}
            type="button"
            onClick={() => respond({ id: request.id, value: option })}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 active:bg-[var(--color-accent)]/10 transition-all"
          >
            {option}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => cancel(request.id)}
        className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <X size={12} /> Cancel request
      </button>
    </div>
  );
}

function ConfirmRequest({ request }: { request: UiRequest }) {
  const respond = useAppStore((state) => state.respondUiRequest);
  const cancel = useAppStore((state) => state.cancelUiRequest);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{request.title ?? "Confirm request"}</h3>
        {request.message && <p className="mt-1 text-xs text-[var(--color-text-secondary)] leading-relaxed">{request.message}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Confirm request"
          onClick={() => respond({ id: request.id, confirmed: true })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] active:bg-[var(--color-accent)] transition-all shadow-sm"
        >
          <Check size={14} /> Confirm
        </button>
        <button
          type="button"
          aria-label="Cancel request"
          onClick={() => cancel(request.id)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3.5 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-all"
        >
          <X size={14} /> Cancel
        </button>
      </div>
    </div>
  );
}

function InputRequest({ request }: { request: UiRequest }) {
  const [value, setValue] = useState(request.prefill ?? "");
  const respond = useAppStore((state) => state.respondUiRequest);
  const cancel = useAppStore((state) => state.cancelUiRequest);
  const title = request.title ?? "Enter a response";
  const inputId = useMemo(() => `ui-request-${request.id}`, [request.id]);
  const isEditor = request.method === "editor";

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        respond({ id: request.id, value });
      }}
    >
      <div>
        <label htmlFor={inputId} className="text-sm font-semibold text-[var(--color-text-primary)]">
          {title}
        </label>
        {isEditor ? (
          <textarea
            id={inputId}
            aria-label={`Response for ${title}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request.placeholder ?? "Type your response…"}
            rows={5}
            className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3.5 py-2.5 text-[16px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/50 transition-colors"
          />
        ) : (
          <input
            id={inputId}
            aria-label={`Response for ${title}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request.placeholder ?? "Type your response…"}
            className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3.5 py-2.5 text-[16px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/50 transition-colors"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          aria-label="Submit response"
          className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] transition-all shadow-sm"
        >
          Submit
        </button>
        <button
          type="button"
          aria-label="Cancel request"
          onClick={() => cancel(request.id)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3.5 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-all"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function NotifyRequest({ request }: { request: UiRequest }) {
  const dismiss = useAppStore((state) => state.dismissUiRequest);
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="text-sm text-[var(--color-text-primary)] leading-relaxed">{request.message ?? "Agent notification"}</p>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(request.id)}
        className="rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
