"use client";

import { ComposerDock } from "./ComposerDock";
import { MessageTimeline } from "./MessageTimeline";
import { StatusBar } from "./StatusBar";

export function ChatPanel() {
  return (
    <div className="flex flex-col h-full">
      <MessageTimeline />
      <ComposerDock />
      <StatusBar />
    </div>
  );
}
