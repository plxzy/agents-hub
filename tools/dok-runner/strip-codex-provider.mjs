import fs from "node:fs";
import path from "node:path";

const dist = "/opt/pi/node_modules/@earendil-works/pi-ai/dist";
const allPath = path.join(dist, "providers/all.js");
const allBefore = fs.readFileSync(allPath, "utf8");
const allAfter = allBefore
  .replace('import { openaiCodexProvider } from "./openai-codex.js";\n', "")
  .replace("        openaiCodexProvider(),\n", "");
if (allAfter === allBefore || allAfter.includes("openaiCodexProvider")) {
  throw new Error("pi-ai provider catalog did not contain the expected Codex entry");
}
fs.writeFileSync(allPath, allAfter);

const modelsPath = path.join(dist, "models.generated.js");
const modelsBefore = fs.readFileSync(modelsPath, "utf8");
const modelsAfter = modelsBefore
  .replace(
    'import { OPENAI_CODEX_CLASSIFIER_MODELS, OPENAI_CODEX_IMAGE_MODELS, OPENAI_CODEX_MODELS } from "./providers/openai-codex.models.js";\n',
    "",
  )
  .replace(/^    "openai-codex": OPENAI_CODEX_[A-Z_]+,\n/gm, "");
if (modelsAfter === modelsBefore || modelsAfter.includes("OPENAI_CODEX")) {
  throw new Error("pi-ai model catalog did not contain the expected Codex entries");
}
fs.writeFileSync(modelsPath, modelsAfter);

const compatPath = path.join(dist, "compat.js");
const compatBefore = fs.readFileSync(compatPath, "utf8");
const compatAfter = compatBefore
  .replace('export * from "./api/openai-codex-responses.lazy.js";\n', "")
  .replace('import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.js";\n', "")
  .replace('    ["openai-codex-responses", openAICodexResponsesApi()],\n', "");
if (compatAfter === compatBefore || compatAfter.includes("openai-codex")) {
  throw new Error("pi-ai compat API catalog did not contain the expected Codex entries");
}
fs.writeFileSync(compatPath, compatAfter);

const legacyPath = path.join(dist, "legacy-api-aliases.js");
const legacyBefore = fs.readFileSync(legacyPath, "utf8");
const legacyAfter = legacyBefore
  .replace('import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.js";\n', "")
  .replace("const openAICodexResponsesStreams = openAICodexResponsesApi();\n", "")
  .replace(/\/\*\* @deprecated Use `stream` from `@earendil-works\/pi-ai\/api\/openai-codex-responses`[^\n]*\nexport const streamOpenAICodexResponses[^\n]*\n\/\*\* @deprecated Use `streamSimple` from `@earendil-works\/pi-ai\/api\/openai-codex-responses`[^\n]*\nexport const streamSimpleOpenAICodexResponses[^\n]*\n/, "");
if (legacyAfter === legacyBefore || legacyAfter.includes("openai-codex")) {
  throw new Error("pi-ai legacy API aliases did not contain the expected Codex entries");
}
fs.writeFileSync(legacyPath, legacyAfter);

const loadPath = path.join(dist, "auth/oauth/load.js");
const loadBefore = fs.readFileSync(loadPath, "utf8");
const loadAfter = loadBefore.replace(
  /export const loadOpenAICodexOAuth = async \(\) => \{[\s\S]*?\n\};\n/,
  "",
);
if (loadAfter === loadBefore || loadAfter.includes("loadOpenAICodexOAuth")) {
  throw new Error("pi-ai OAuth loader did not contain the expected Codex entry");
}
fs.writeFileSync(loadPath, loadAfter);

const loadTypes = path.join(dist, "auth/oauth/load.d.ts");
if (fs.existsSync(loadTypes)) {
  fs.writeFileSync(
    loadTypes,
    fs.readFileSync(loadTypes, "utf8").replace("export declare const loadOpenAICodexOAuth: () => Promise<OAuthAuth>;\n", ""),
  );
}

const manifestPath = path.join(dist, "providers/data/.manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
delete manifest.files["openai-codex.json"];
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.toLowerCase().includes("codex")) fs.rmSync(full);
    else if (entry.name.endsWith(".map") && /codex/i.test(fs.readFileSync(full, "utf8"))) fs.rmSync(full);
  }
}
walk(dist);

const { builtinProviders } = await import(`${allPath}?codex-stripped=${Date.now()}`);
const ids = builtinProviders().map((provider) => provider.id);
if (ids.includes("openai-codex") || !ids.includes("openai")) {
  throw new Error(`unexpected pi-ai provider catalog after stripping: ${ids.join(",")}`);
}
