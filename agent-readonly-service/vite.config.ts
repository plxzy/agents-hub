import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { dashboardHtml } from "../agent-workflow/ui/dashboard.mjs";

const VIRTUAL = "virtual:agents-hub-dashboard";
const RESOLVED = `\0${VIRTUAL}`;

function dashboardAsset(): Plugin {
  return {
    name: "agents-hub-dashboard",
    resolveId(id) { return id === VIRTUAL ? RESOLVED : undefined; },
    load(id) {
      if (id !== RESOLVED) return undefined;
      // The same page the local server serves, with the MCP Apps bridge inlined (hosts block script URLs).
      return `export default ${JSON.stringify(dashboardHtml())};`;
    },
  };
}

export default defineConfig({ plugins: [dashboardAsset(), cloudflare()] });
