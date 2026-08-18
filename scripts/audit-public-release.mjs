import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const root = process.cwd();
const publicFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root }).toString().split("\0").filter(Boolean);
const findings = [];

const forbiddenTracked = /(^|[\\/])(?:\.env(?:\..*)?|node_modules|dist|target|runtime|test-results|playwright-report|output|\.pnpm-store)(?:[\\/]|$)/i;
for (const file of publicFiles) {
  if (file === ".env.example") continue;
  if (forbiddenTracked.test(file)) findings.push(`${file}: generated or private path is tracked`);
}

const textExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".sql", ".toml", ".yaml", ".yml", ".css", ".html", ".rs"]);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:^|[^A-Z])(AKIA[0-9A-Z]{16})(?:[^A-Z]|$)/
];
const personalPathPattern = /(?:[A-Za-z]:\\Users\\|\/Users\/)[^\s"'`<>]+/i;
for (const file of publicFiles) {
  if (!textExtensions.has(extname(file).toLowerCase())) continue;
  const content = readFileSync(join(root, file), "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) findings.push(`${file}: likely credential material detected`);
  if (personalPathPattern.test(content)) findings.push(`${file}: local user path detected`);
}

const requiredFiles = [".env.example", "README.md", "SECURITY.md", "CONTRIBUTING.md", "docs/GITHUB_PUBLICATION_PLAN.md"];
for (const file of requiredFiles) if (!existsSync(join(root, file))) findings.push(`${file}: required publication file is missing`);

const ignore = readFileSync(join(root, ".gitignore"), "utf8");
for (const entry of [".env", "dist/", "apps/desktop/src-tauri/target/", "apps/desktop/src-tauri/runtime/"]) {
  if (!ignore.includes(entry)) findings.push(`.gitignore: missing ${entry}`);
}

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const desktopPackage = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const cargo = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = { root: rootPackage.version, desktop: desktopPackage.version, tauri: tauri.version, cargo };
if (new Set(Object.values(versions)).size !== 1) findings.push(`version mismatch: ${JSON.stringify(versions)}`);

if (findings.length) {
  console.error("Public release audit failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Public release audit passed: ${publicFiles.length} public files checked; version ${rootPackage.version} is consistent.`);
