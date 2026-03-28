import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/db", "packages/adapters/opencode-local", "packages/adapters/crewdeck", "server", "ui", "cli"],
  },
});
