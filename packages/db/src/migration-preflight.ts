import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { DatabaseConfig } from "./config.js";
import { assertMigrationTarget } from "./migration-guard.js";

export type MigrationActivity = {
  activeFocusSessions: number;
  processingFocusTimerJobs: number;
  processingReminderJobs: number;
  otherApplicationConnections: number;
};

export type MigrationPreflightResult = MigrationActivity & {
  backupPath: string;
};

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const defaultBackupDirectory = resolve(sourceDirectory, "../../../backups/migrations");

export function migrationBlockers(activity: MigrationActivity): string[] {
  const blockers: string[] = [];
  if (activity.activeFocusSessions > 0) blockers.push("active focus sessions exist");
  if (activity.processingFocusTimerJobs > 0) blockers.push("focus timer jobs are processing");
  if (activity.processingReminderJobs > 0) blockers.push("reminder jobs are processing");
  if (activity.otherApplicationConnections > 0) blockers.push("other application database connections are still open");
  return blockers;
}

export function migrationBackupFileName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(".", "_");
  return `personal_ai_assistant_pre_migration_${stamp}.backup`;
}

async function readMigrationActivity(client: Client): Promise<MigrationActivity> {
  const tables = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('focus_sessions', 'focus_timer_jobs', 'reminder_jobs')
  `);
  const existingTables = new Set(tables.rows.map((row) => row.table_name));
  const count = async (table: string, predicate: string): Promise<number> => {
    if (!existingTables.has(table)) return 0;
    const result = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE ${predicate}`);
    return result.rows[0]?.count ?? 0;
  };
  const connections = await client.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE datname = current_database()
      AND usename = current_user
      AND pid <> pg_backend_pid()
  `);
  return {
    activeFocusSessions: await count("focus_sessions", "state IN ('preparing', 'running', 'paused')"),
    processingFocusTimerJobs: await count("focus_timer_jobs", "status = 'processing'"),
    processingReminderJobs: await count("reminder_jobs", "status = 'processing'"),
    otherApplicationConnections: connections.rows[0]?.count ?? 0
  };
}

function pgDumpArguments(config: DatabaseConfig, backupPath: string): { args: string[]; password: string | undefined } {
  const databaseUrl = new URL(config.DATABASE_URL);
  const password = databaseUrl.password ? decodeURIComponent(databaseUrl.password) : undefined;
  const host = databaseUrl.hostname;
  const port = databaseUrl.port || String(config.EXPECTED_DB_PORT);
  const user = decodeURIComponent(databaseUrl.username);
  const database = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));

  return {
    args: [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--host", host,
      "--port", port,
      "--username", user,
      "--dbname", database,
      "--file", backupPath
    ],
    password
  };
}

export function pgDumpCommand(config: DatabaseConfig): string {
  const configured = process.env.PERSONAL_AI_PG_DUMP_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
      (value): value is string => Boolean(value)
    );
    for (const root of roots) {
      const candidate = resolve(root, "PostgreSQL", String(config.EXPECTED_PG_MAJOR), "bin", "pg_dump.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "pg_dump";
}

export async function createMigrationBackup(
  config: DatabaseConfig,
  backupDirectory = defaultBackupDirectory,
  now = new Date()
): Promise<string> {
  await mkdir(backupDirectory, { recursive: true });
  const backupPath = resolve(backupDirectory, migrationBackupFileName(now));
  const { args, password } = pgDumpArguments(config, backupPath);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(pgDumpCommand(config), args, {
      windowsHide: true,
      env: password ? { ...process.env, PGPASSWORD: password } : process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => reject(new Error(`pg_dump could not start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise();
      const detail = stderr.trim().slice(-1200);
      reject(new Error(`pg_dump failed (code=${code ?? "null"}, signal=${signal ?? "none"})${detail ? `: ${detail}` : "."}`));
    });
  });

  const file = await stat(backupPath);
  if (file.size <= 0) throw new Error("pg_dump created an empty migration backup.");
  return backupPath;
}

export async function runMigrationPreflight(
  config: DatabaseConfig,
  backupDirectory = defaultBackupDirectory
): Promise<MigrationPreflightResult> {
  await assertMigrationTarget(config);
  const client = new Client({ connectionString: config.DATABASE_URL });
  try {
    await client.connect();
    const activity = await readMigrationActivity(client);
    const blockers = migrationBlockers(activity);
    if (blockers.length > 0) {
      throw new Error(`Migration refused before backup: ${blockers.join("; ")}.`);
    }
    const backupPath = await createMigrationBackup(config, backupDirectory);
    return { ...activity, backupPath };
  } finally {
    await client.end();
  }
}
