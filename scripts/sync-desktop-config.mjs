import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(repositoryRoot, ".env");
const roamingDirectory = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
const targetPath = join(roamingDirectory, "com.personalai.assistant", ".env");

if (!existsSync(sourcePath)) throw new Error("repository .env does not exist");
if (!existsSync(targetPath)) throw new Error("desktop configuration does not exist; run the installed app once first");

const source = readFileSync(sourcePath, "utf8");
const target = readFileSync(targetPath, "utf8");
const configured = new Map();

for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
  if (!match || !match[2].trim()) continue;
  configured.set(match[1], match[2]);
}

const applied = new Set();
const nextLines = target.split(/\r?\n/).map((line) => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
  if (!match || !configured.has(match[1])) return line;
  applied.add(match[1]);
  return `${match[1]}=${configured.get(match[1])}`;
});
for (const [key, value] of configured) {
  if (!applied.has(key)) nextLines.push(`${key}=${value}`);
}

writeFileSync(targetPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
console.log(`Synchronized ${configured.size} configured values to the private desktop configuration.`);
console.log(targetPath);
