import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const CREWDECK_SERVICE_URL = process.env.CREWDECK_SERVICE_URL ?? "http://localhost:3200";

// Roles that should get task delegation permissions
const LEAD_ROLES = ["ceo", "lead", "cto", "manager"];

async function registerAgent(event: PluginEvent, logger: { info: (msg: string) => void; error: (msg: string) => void }) {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return;

  const agentId = event.entityId;
  const agentName = (payload.name as string) ?? "unknown";
  const agentRole = (payload.role as string) ?? "general";
  const companyId = event.companyId;

  const sandboxName = `agent-${agentId?.slice(0, 8) ?? "unknown"}`;

  try {
    const res = await fetch(`${CREWDECK_SERVICE_URL}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperclipAgentId: agentId,
        sandboxName,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Failed to register agent ${agentName}: ${res.status} ${body}`);
      return;
    }

    logger.info(`Agent '${agentName}' registered with CrewDeck Service → sandbox '${sandboxName}'`);

    // Grant lead permissions if applicable
    if (LEAD_ROLES.includes(agentRole) && companyId && agentId) {
      logger.info(`Granting lead permissions to '${agentName}' (role: ${agentRole})`);
    }
  } catch (err) {
    logger.error(`Failed to register agent ${agentName}: ${err}`);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("CrewDeck Sync plugin started");

    ctx.events.on("agent.created", async (event: PluginEvent) => {
      ctx.logger.info(`New agent detected: ${event.entityId}`);
      await registerAgent(event, ctx.logger);
    });
  },

  async onHealth() {
    return { status: "ok", message: "CrewDeck Sync plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
