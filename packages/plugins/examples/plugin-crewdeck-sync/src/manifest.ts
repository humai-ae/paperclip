import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "crewdeck.sync";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "CrewDeck Sync",
  description: "Automatically registers new agents with CrewDeck Service for sandbox provisioning.",
  author: "CrewDeck",
  categories: ["automation"],
  capabilities: ["events.subscribe", "http.outbound"],
  entrypoints: {
    worker: "./src/worker.ts",
  },
};

export default manifest;
