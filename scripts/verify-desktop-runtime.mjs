import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(repositoryRoot, "apps", "desktop", "src-tauri", "runtime");
const envFile = join(repositoryRoot, ".env");
const node = join(runtimeRoot, "node.exe");
const api = join(runtimeRoot, "api", "dist", "server.js");
const worker = join(runtimeRoot, "worker", "dist", "worker.js");
const port = "39091";

if (!existsSync(node) || !existsSync(api) || !existsSync(worker)) {
  throw new Error("standalone runtime is missing; run pnpm prepare:desktop-runtime first");
}
if (!existsSync(envFile)) {
  throw new Error("local verification requires the ignored repository .env file");
}
const localConfiguration = parseEnv(readFileSync(envFile, "utf8"));

const child = spawn(node, [api], {
  cwd: runtimeRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: port,
    PERSONAL_AI_ENV_FILE: envFile
  }
});
let errorOutput = "";
let standardOutput = "";
child.stdout?.on("data", (chunk) => {
  standardOutput += String(chunk);
});
child.stderr?.on("data", (chunk) => {
  errorOutput += String(chunk);
});

try {
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && (await response.json()).status === "ok") {
        healthy = true;
        break;
      }
    } catch {
      // The API can still be opening its database connection.
    }
  }
  if (!healthy) {
    throw new Error(`standalone API did not become healthy${errorOutput ? `: ${errorOutput}` : ""}`);
  }
  const expectsFeishuWebSocket = localConfiguration.FEISHU_CALLBACK_TRANSPORT !== "http"
    && Boolean(localConfiguration.FEISHU_APP_ID)
    && Boolean(localConfiguration.FEISHU_APP_SECRET)
    && Boolean(localConfiguration.FEISHU_TARGET_OPEN_ID);
  if (expectsFeishuWebSocket) {
    for (let attempt = 0; attempt < 30 && !standardOutput.includes("Feishu long connection established."); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    if (!standardOutput.includes("Feishu long connection established.")) {
      throw new Error(`standalone Feishu long connection was not established${errorOutput ? `: ${errorOutput}` : ""}`);
    }
    console.log("standalone-runtime-feishu-websocket: ok");
  }
  console.log("standalone-runtime-health: ok");
} finally {
  child.kill();
}

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const rawValue = match[2];
    values[match[1]] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  }
  return values;
}
