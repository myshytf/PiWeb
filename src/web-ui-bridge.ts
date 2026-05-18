import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WsEventData } from "./agent-events.js";

export type WebUIRequestMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify";

export interface WebUIPendingRequest {
  id: string;
  method: WebUIRequestMethod;
  createdAt: number;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
}

export type WebUIResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

type PendingRequest<T> = {
  request: WebUIPendingRequest;
  resolve: (value: T) => void;
  parse: (response: WebUIResponse) => T;
  timeoutId?: ReturnType<typeof setTimeout>;
};

export function uiRequestEvent(request: WebUIPendingRequest): WsEventData {
  return { type: "ui_request", data: request };
}

export function uiRequestResolvedEvent(id: string, reason: "responded" | "cancelled" | "timeout"): WsEventData {
  return { type: "ui_request_resolved", data: { id, reason } };
}

export function createWebUIBridge(broadcast: (event: WsEventData) => void): WebUIBridge {
  return new WebUIBridge(broadcast);
}

export class WebUIBridge {
  private pending = new Map<string, PendingRequest<any>>();

  constructor(private broadcast: (event: WsEventData) => void) {}

  getPendingRequests(): WebUIPendingRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  getPendingRequest(id: string): WebUIPendingRequest | undefined {
    return this.pending.get(id)?.request;
  }

  respond(response: WebUIResponse): boolean {
    const entry = this.pending.get(response.id);
    if (!entry) return false;
    this.pending.delete(response.id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    this.broadcast(uiRequestResolvedEvent(response.id, "cancelled" in response ? "cancelled" : "responded"));
    entry.resolve(entry.parse(response));
    return true;
  }

  cancel(id: string): boolean {
    return this.respond({ id, cancelled: true });
  }

  replayPendingRequests(send?: (event: WsEventData) => void): void {
    const emit = send ?? this.broadcast;
    for (const request of this.getPendingRequests()) {
      emit(uiRequestEvent(request));
    }
  }

  private emitFireAndForget(request: Omit<WebUIPendingRequest, "id" | "createdAt">): void {
    this.broadcast(uiRequestEvent({ id: randomUUID(), createdAt: Date.now(), ...request }));
  }

  private createDialogPromise<T>(
    request: Omit<WebUIPendingRequest, "id" | "createdAt">,
    defaultValue: T,
    parse: (response: WebUIResponse) => T,
  ): Promise<T> {
    const id = randomUUID();
    const pendingRequest: WebUIPendingRequest = { id, createdAt: Date.now(), ...request };

    return new Promise<T>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (request.timeout && request.timeout > 0) {
        timeoutId = setTimeout(() => {
          this.pending.delete(id);
          this.broadcast(uiRequestResolvedEvent(id, "timeout"));
          resolve(defaultValue);
        }, request.timeout);
      }

      this.pending.set(id, { request: pendingRequest, resolve, parse, timeoutId });
      this.broadcast(uiRequestEvent(pendingRequest));
    });
  }

  uiContext: ExtensionUIContext = {
    select: (title, options, opts) =>
      this.createDialogPromise<string | undefined>(
        { method: "select", title, options, timeout: opts?.timeout },
        undefined,
        (response) => ("value" in response ? response.value : undefined),
      ),

    confirm: (title, message, opts) =>
      this.createDialogPromise<boolean>(
        { method: "confirm", title, message, timeout: opts?.timeout },
        false,
        (response) => ("confirmed" in response ? response.confirmed : false),
      ),

    input: (title, placeholder, opts) =>
      this.createDialogPromise<string | undefined>(
        { method: "input", title, placeholder, timeout: opts?.timeout },
        undefined,
        (response) => ("value" in response ? response.value : undefined),
      ),

    notify: (message, type) => {
      this.emitFireAndForget({ method: "notify", message, notifyType: type });
    },

    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key, content, options) => {
      void key;
      void content;
      void options;
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: (text) => this.uiContext.setEditorText(text),
    setEditorText: () => {},
    getEditorText: () => "",
    editor: (title, prefill) =>
      this.createDialogPromise<string | undefined>(
        { method: "editor", title, prefill },
        undefined,
        (response) => ("value" in response ? response.value : undefined),
      ),
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return {} as any;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in pi-web" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
