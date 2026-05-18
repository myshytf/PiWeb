"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppStore, type ChatMessage as ChatMessageType } from "@/stores/app-store";
import { ChatMessage } from "./ChatMessage";
import { ChevronDown } from "lucide-react";

const VIRTUALIZE_AFTER = 80;
const ESTIMATED_ROW_HEIGHT = 180;
const OVERSCAN = 8;

interface VirtualRowProps {
  message: ChatMessageType;
  isLastMessage: boolean;
  onMeasure: (id: string, height: number) => void;
}

const VirtualRow = memo(function VirtualRow({ message, isLastMessage, onMeasure }: VirtualRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;

    const report = () => {
      const height = el.getBoundingClientRect().height;
      if (height > 0) onMeasure(message.id, height);
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [message.id, onMeasure]);

  return (
    <div ref={rowRef} data-message-id={message.id}>
      <ChatMessage message={message} isLastMessage={isLastMessage} />
    </div>
  );
});

export function MessageTimeline() {
  const messages = useAppStore((state) => state.messages);
  const pendingFollowUps = useAppStore((state) => state.pendingFollowUps);
  const sessionFile = useAppStore((state) => state.sessionFile);
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const isNearBottomRef = useRef(true);
  const autoFollowRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);
  const prevSessionFileRef = useRef<string | null>(sessionFile);
  const lastUserScrollIntentAtRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const scrollStateRafRef = useRef<number | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);

  const shouldVirtualize = messages.length > VIRTUALIZE_AFTER;

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = Date.now();
  }, []);

  const measureRow = useCallback((id: string, height: number) => {
    const previous = rowHeightsRef.current.get(id);
    if (previous !== undefined && Math.abs(previous - height) < 1) return;
    rowHeightsRef.current.set(id, height);
    setHeightVersion((v) => v + 1);
  }, []);

  const getRowHeight = useCallback((message: ChatMessageType) => {
    return rowHeightsRef.current.get(message.id) ?? ESTIMATED_ROW_HEIGHT;
  }, []);

  const virtualLayout = useMemo(() => {
    // `heightVersion` intentionally makes this recompute when ResizeObserver reports better heights.
    void heightVersion;

    if (!shouldVirtualize) {
      return {
        start: 0,
        end: messages.length,
        topPadding: 0,
        bottomPadding: 0,
      };
    }

    const targetTop = Math.max(0, scrollTop);
    const targetBottom = targetTop + Math.max(viewportHeight, 1);
    let accumulated = 0;
    let start = 0;
    let end = messages.length;

    for (let i = 0; i < messages.length; i++) {
      const next = accumulated + getRowHeight(messages[i]);
      if (next >= targetTop) {
        start = Math.max(0, i - OVERSCAN);
        break;
      }
      accumulated = next;
    }

    let visibleBottom = 0;
    for (let i = 0; i < messages.length; i++) {
      visibleBottom += getRowHeight(messages[i]);
      if (visibleBottom >= targetBottom) {
        end = Math.min(messages.length, i + 1 + OVERSCAN);
        break;
      }
    }

    let topPadding = 0;
    for (let i = 0; i < start; i++) topPadding += getRowHeight(messages[i]);

    let bottomPadding = 0;
    for (let i = end; i < messages.length; i++) bottomPadding += getRowHeight(messages[i]);

    return { start, end, topPadding, bottomPadding };
  }, [messages, shouldVirtualize, scrollTop, viewportHeight, getRowHeight, heightVersion]);

  const visibleMessages = shouldVirtualize
    ? messages.slice(virtualLayout.start, virtualLayout.end)
    : messages;

  const jumpToBottomNow = useCallback((enableAutoFollow = true) => {
    const el = containerRef.current;
    if (!el) return;

    if (enableAutoFollow) {
      autoFollowRef.current = true;
      isNearBottomRef.current = true;
      setShowScrollButton(false);
    }

    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
  }, []);

  const jumpToBottom = useCallback((enableAutoFollow = true) => {
    if (enableAutoFollow) {
      autoFollowRef.current = true;
      isNearBottomRef.current = true;
      setShowScrollButton(false);
    }

    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }

    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      jumpToBottomNow(false);
    });
  }, [jumpToBottomNow]);

  const scrollToBottom = useCallback(() => {
    autoFollowRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    if (shouldVirtualize) {
      jumpToBottom(true);
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [shouldVirtualize, jumpToBottom]);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
  }, []);

  // Track scroll position and user intent.
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    if (scrollStateRafRef.current === null) {
      scrollStateRafRef.current = requestAnimationFrame(() => {
        scrollStateRafRef.current = null;
        updateScrollState();
      });
    }

    const threshold = 120;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isNearBottomRef.current = nearBottom;

    if (nearBottom) {
      autoFollowRef.current = true;
      setShowScrollButton(false);
      return;
    }

    // If the user recently touched/wheeled/dragged, treat being away from bottom
    // as intentional reading and stop auto-following streaming deltas.
    if (Date.now() - lastUserScrollIntentAtRef.current < 1200) {
      autoFollowRef.current = false;
    }
    setShowScrollButton(true);
  }, [updateScrollState]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);

    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
      if (autoFollowRef.current) jumpToBottom(false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [jumpToBottom]);

  // On session switch, reset scroll bookkeeping and anchor to bottom before paint.
  // This prevents stale scrollTop from the previous session causing a blank/black viewport.
  useLayoutEffect(() => {
    if (prevSessionFileRef.current === sessionFile) return;

    prevSessionFileRef.current = sessionFile;
    prevMessageCountRef.current = 0;
    rowHeightsRef.current.clear();
    setHeightVersion((v) => v + 1);
    autoFollowRef.current = true;
    isNearBottomRef.current = true;
    setShowScrollButton(false);

    // Critical: do this synchronously in layout phase, not RAF-after-paint.
    jumpToBottomNow(true);
    requestAnimationFrame(() => jumpToBottomNow(true));
  }, [sessionFile, jumpToBottomNow]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (scrollStateRafRef.current !== null) cancelAnimationFrame(scrollStateRafRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const newMsgCount = messages.length;
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = newMsgCount;

    const isNewMessage = newMsgCount > prevCount;
    const shouldAutoFollow = autoFollowRef.current || isNearBottomRef.current;

    if (!shouldAutoFollow) return;

    // New session snapshots / message replacement need pre-paint anchoring to avoid blank virtualized viewport.
    if (isNewMessage || sessionFile !== prevSessionFileRef.current) {
      jumpToBottomNow(true);
    } else {
      jumpToBottom(false);
    }
  }, [messages, pendingFollowUps, sessionFile, jumpToBottom, jumpToBottomNow]);

  const hasMessages = messages.length > 0 || pendingFollowUps.length > 0;

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 md:px-4"
        data-testid="message-timeline"
      >
        {!hasMessages && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-4">
              <div className="text-4xl mb-4">π</div>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">pi Remote</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mb-1">
                Web remote control for pi agent
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Send a message or attach file context to start a conversation
              </p>
            </div>
          </div>
        )}

        {shouldVirtualize && virtualLayout.topPadding > 0 && (
          <div style={{ height: virtualLayout.topPadding }} aria-hidden="true" />
        )}

        {visibleMessages.map((msg, index) => {
          const absoluteIndex = shouldVirtualize ? virtualLayout.start + index : index;
          const isLastMessage = absoluteIndex === messages.length - 1;
          return shouldVirtualize ? (
            <VirtualRow key={msg.id} message={msg} isLastMessage={isLastMessage} onMeasure={measureRow} />
          ) : (
            <ChatMessage key={msg.id} message={msg} isLastMessage={isLastMessage} />
          );
        })}

        {shouldVirtualize && virtualLayout.bottomPadding > 0 && (
          <div style={{ height: virtualLayout.bottomPadding }} aria-hidden="true" />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to bottom button */}
      {showScrollButton && hasMessages && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 z-10 flex items-center justify-center size-10 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] shadow-lg hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] active:bg-[var(--color-bg-active)] transition-all animate-in fade-in slide-in-from-bottom-1"
          title="Scroll to latest"
          aria-label="Scroll to latest messages"
        >
          <ChevronDown size={18} />
        </button>
      )}
    </div>
  );
}
