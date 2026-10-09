import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const VIRTUAL = "virtual:agents-hub-dashboard";
const RESOLVED = `\0${VIRTUAL}`;

function dashboardAsset(): Plugin {
  return {
    name: "agents-hub-dashboard",
    resolveId(id) { return id === VIRTUAL ? RESOLVED : undefined; },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const source = fs.readFileSync(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../agent-workflow/ui/dashboard.html"), "utf8");
      return `export default ${JSON.stringify(source)};`;
    },
  };
}

export default defineConfig({ plugins: [dashboardAsset(), cloudflare()] });
