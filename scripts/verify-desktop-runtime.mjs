import { spawn, spawnSync } from "node:child_process";
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
const migration = join(runtimeRoot, "api", "node_modules", "@personal-ai", "db", "dist", "migrate.js");
const migrationFolder = join(runtimeRoot, "api", "node_modules", "@personal-ai", "db", "drizzle");
const migrationJournal = join(migrationFolder, "meta", "_journal.json");
const bundledEnv = join(runtimeRoot, ".env");
const port = "39091";

if (!existsSync(node) || !existsSync(api) || !existsSync(worker) || !existsSync(migration) || !existsSync(migrationJournal)) {
  throw new Error("standalone runtime is missing; run pnpm prepare:desktop-runtime first");
}
const journal = JSON.parse(readFileSync(migrationJournal, "utf8"));
const latestMigration = journal.entries?.at(-1)?.tag;
if (typeof latestMigration !== "string" || !existsSync(join(migrationFolder, `${latestMigration}.sql`))) {
  throw new Error("standalone runtime is missing the latest Drizzle migration");
}
if (!existsSync(envFile)) {
  throw new Error("local verification requires the ignored repository .env file");
}
if (existsSync(bundledEnv)) {
  throw new Error("standalone runtime must never contain the private repository .env file");
}
for (const entrypoint of [api, worker, migration]) {
  const syntax = spawnSync(node, ["--check", entrypoint], { cwd: runtimeRoot, encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`standalone entrypoint syntax check failed for ${entrypoint}: ${syntax.stderr || syntax.stdout}`);
  }
}

const child = spawn(node, [api], {
  cwd: runtimeRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: port,
    PERSONAL_AI_ENV_FILE: envFile,
    // External Feishu delivery was already accepted separately. Packaging QA
    // verifies the local runtime without opening a duplicate long connection.
    FEISHU_CALLBACK_TRANSPORT: "http"
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
    if (child.exitCode !== null) break;
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
    const diagnostics = [
      child.exitCode === null ? "process still running" : `process exited with code ${child.exitCode}`,
      errorOutput.trim() ? `stderr: ${errorOutput.trim()}` : "",
      standardOutput.trim() ? `stdout: ${standardOutput.trim()}` : ""
    ].filter(Boolean).join("; ");
    throw new Error(`standalone API did not become healthy (${diagnostics || "no process diagnostics"})`);
  }
  const capabilities = await fetchJson(`http://127.0.0.1:${port}/api/v1/health/capabilities`);
  if (typeof capabilities.sleepImageAnalysis !== "boolean") {
    throw new Error("standalone health capability response is missing sleepImageAnalysis");
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const taskList = await fetchJson(`http://127.0.0.1:${port}/api/v1/tasks?date=${today}`);
  if (!Array.isArray(taskList.tasks)) {
    throw new Error("standalone task list response is malformed");
  }
  const exactTask = taskList.tasks.find((task) => task?.scheduleKind === "exact" && typeof task?.id === "string");
  if (exactTask) {
    const structures = await fetchJson(`http://127.0.0.1:${port}/api/v1/tasks/${exactTask.id}/focus-structures`);
    if (!Array.isArray(structures.focusStructures)) {
      throw new Error("standalone focus structure response is malformed");
    }
  }
  console.log("standalone-runtime-health-capabilities: ok");
  console.log("standalone-runtime-task-read: ok");
  console.log(`standalone-runtime-focus-structure-read: ${exactTask ? "ok" : "skipped (no exact task today)"}`);
  console.log("standalone-runtime-worker-syntax: ok");
  console.log(`standalone-runtime-migrations: ok (${latestMigration})`);
  console.log("standalone-runtime-private-env-excluded: ok");
  console.log("standalone-runtime-health: ok");
} finally {
  child.kill();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}
