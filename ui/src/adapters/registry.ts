import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { crewdeckUIAdapter } from "./crewdeck";
import { cursorLocalUIAdapter } from "./cursor";
import { geminiLocalUIAdapter } from "./gemini-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";

const uiAdapters: UIAdapterModule[] = [
  claudeLocalUIAdapter,
  codexLocalUIAdapter,
  geminiLocalUIAdapter,
  openCodeLocalUIAdapter,
  piLocalUIAdapter,
  cursorLocalUIAdapter,
  crewdeckUIAdapter,
];

const adaptersByType = new Map<string, UIAdapterModule>(
  uiAdapters.map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? crewdeckUIAdapter;
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
