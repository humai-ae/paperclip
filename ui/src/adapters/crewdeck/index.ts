import type { UIAdapterModule } from "../types";
import { parseOpenClawGatewayStdoutLine } from "@paperclipai/adapter-openclaw-gateway/ui";

const NoConfigFields = () => null;

export const crewdeckUIAdapter: UIAdapterModule = {
  type: "crewdeck",
  label: "CrewDeck (Sandboxed)",
  parseStdoutLine: parseOpenClawGatewayStdoutLine,
  ConfigFields: NoConfigFields,
  buildAdapterConfig: () => ({}),
};
