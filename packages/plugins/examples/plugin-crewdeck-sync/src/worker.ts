import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginEvent, PluginHttpClient } from "@paperclipai/plugin-sdk";

const CREWDECK_SERVICE_URL = process.env.CREWDECK_SERVICE_URL ?? "http://localhost:3200";

async function registerAgent(
  event: PluginEvent,
  http: PluginHttpClient,
  logger: { info: (msg: string) => void; error: (msg: string) => void },
) {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || !event.entityId) return;
  const profileAdapterType =
    typeof payload.profileAdapterType === "string" && payload.profileAdapterType.trim()
      ? payload.profileAdapterType.trim()
      : null;
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : null;
  if (!profileAdapterType || !model) {
    logger.error(
      `Skipping CrewDeck registration for ${event.entityId}: missing profileAdapterType/model in event payload`,
    );
    return;
  }

  try {
    const res = await http.fetch(`${CREWDECK_SERVICE_URL}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperclipAgentId: event.entityId,
        role: typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : "general",
        profileAdapterType,
        model,
      }),
    });

    if (!res.ok) {
      logger.error(`Failed to register agent ${event.entityId}: ${res.status} ${await res.text()}`);
      return;
    }

    logger.info(`Agent ${event.entityId} registered with CrewDeck Service`);
  } catch (err) {
    logger.error(`Failed to register agent ${event.entityId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("CrewDeck Sync plugin started");
    ctx.events.on("agent.created", async (event: PluginEvent) => {
      await registerAgent(event, ctx.http, ctx.logger);
    });
    ctx.events.on("agent.hire_created", async (event: PluginEvent) => {
      await registerAgent(event, ctx.http, ctx.logger);
    });
  },

  async onHealth() {
    return { status: "ok", message: "CrewDeck Sync plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
