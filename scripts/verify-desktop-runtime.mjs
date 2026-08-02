import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

const child = spawn(node, [api], {
  cwd: runtimeRoot,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: port,
    PERSONAL_AI_ENV_FILE: envFile
  }
});
const workerChild = spawn(node, [worker], {
  cwd: runtimeRoot,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    PERSONAL_AI_ENV_FILE: envFile
  }
});

let errorOutput = "";
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
  console.log("standalone-runtime-health: ok");
} finally {
  child.kill();
  workerChild.kill();
}
