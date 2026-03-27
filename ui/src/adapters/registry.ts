import type { UIAdapterModule } from "./types";
import { crewdeckUIAdapter } from "./crewdeck";

const uiAdapters: UIAdapterModule[] = [
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
