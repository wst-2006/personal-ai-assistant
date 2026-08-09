import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = readJson(join(repositoryRoot, "package.json"));
const desktopPackage = readJson(join(repositoryRoot, "apps", "desktop", "package.json"));
const tauriRoot = join(repositoryRoot, "apps", "desktop", "src-tauri");
const tauriConfig = readJson(join(tauriRoot, "tauri.conf.json"));
const cargoManifest = readFileSync(join(tauriRoot, "Cargo.toml"), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = new Set([
  rootPackage.version,
  desktopPackage.version,
  tauriConfig.version,
  cargoVersion
]);

assert(versions.size === 1 && !versions.has(undefined), "desktop release versions are inconsistent");
const version = tauriConfig.version;
const releaseExecutable = join(tauriRoot, "target", "release", "personal-ai-desktop.exe");
const installer = join(
  tauriRoot,
  "target",
  "release",
  "bundle",
  "nsis",
  `Personal AI Assistant_${version}_x64-setup.exe`
);
const generatedInstaller = join(tauriRoot, "target", "release", "nsis", "x64", "installer.nsi");
const runtimeRoot = join(tauriRoot, "runtime");
const requiredRuntimeFiles = [
  "node.exe",
  join("api", "dist", "server.js"),
  join("worker", "dist", "worker.js"),
  ".env.example"
];

for (const file of [releaseExecutable, installer, generatedInstaller]) {
  assert(existsSync(file), `desktop release artifact is missing: ${file}`);
}
for (const relativePath of requiredRuntimeFiles) {
  assert(existsSync(join(runtimeRoot, relativePath)), `desktop runtime file is missing: ${relativePath}`);
}
assert(!existsSync(join(runtimeRoot, ".env")), "private .env must not be bundled into the installer");
for (const service of ["api", "worker"]) {
  const releaseFiles = readdirSync(join(runtimeRoot, service, "dist"), { recursive: true });
  assert(
    !releaseFiles.some((file) => /(?:\.test|\.verify)\.js$/i.test(String(file)) || /(?:^|[\\/])testing(?:[\\/]|$)/i.test(String(file))),
    `${service} release output still contains tests or verification helpers`
  );
}

const hookPath = tauriConfig.bundle?.windows?.nsis?.installerHooks;
assert(typeof hookPath === "string", "NSIS installer hooks are not configured");
const installerHookFile = join(tauriRoot, hookPath);
assert(existsSync(installerHookFile), "configured NSIS installer hook file is missing");
assert(
  !existsSync(join(tauriRoot, "installer", "stop-bundled-runtime.ps1")),
  "obsolete PowerShell runtime cleanup file must not ship"
);
const hookSource = readFileSync(installerHookFile, "utf8");
for (const marker of [
  "NSIS_HOOK_PREINSTALL",
  "NSIS_HOOK_PREUNINSTALL",
  "MAINBINARYSRCPATH",
  "--cleanup-installed-runtime"
]) {
  assert(hookSource.includes(marker), `NSIS installer hooks are missing marker: ${marker}`);
}
for (const forbiddenMarker of ["powershell", "EncodedCommand", "PERSONAL_AI_RUNTIME_NODE", "stop-bundled-runtime.ps1"]) {
  assert(
    !hookSource.toLowerCase().includes(forbiddenMarker.toLowerCase()),
    `NSIS installer hooks still use forbidden shell cleanup: ${forbiddenMarker}`
  );
}

const executableBytes = readFileSync(releaseExecutable);
assert(readPeSubsystem(executableBytes, "desktop executable") === 2, "desktop executable must use the Windows GUI subsystem");
assert(readPeSubsystem(readFileSync(installer), "desktop installer") === 2, "desktop installer must use the Windows GUI subsystem");

const generatedSource = readFileSync(generatedInstaller, "utf8");
for (const marker of [
  "NSIS_HOOK_PREINSTALL",
  "installer-hooks.nsh",
  "PERSONAL_AI_SAFE_IN_PLACE_UPGRADE",
  "runtime\\node.exe",
  "api\\dist\\server.js",
  "worker\\dist\\worker.js"
]) {
  assert(generatedSource.includes(marker), `generated NSIS installer is missing marker: ${marker}`);
}

const installerSize = statSync(installer).size;
assert(installerSize > 10_000_000, `desktop installer is unexpectedly small: ${installerSize} bytes`);
await verifyExactPathCleanup(join(runtimeRoot, "node.exe"), releaseExecutable);
verifyMissingRuntimeCleanup(releaseExecutable, join(runtimeRoot, "missing-node.exe"));
const sha256 = createHash("sha256").update(readFileSync(installer)).digest("hex").toUpperCase();

console.log(`desktop-installer-version: ${version}`);
console.log("desktop-installer-gui-subsystem: ok");
console.log("desktop-installer-runtime-files: ok");
console.log("desktop-installer-process-cleanup-hook: ok");
console.log("desktop-installer-exact-path-cleanup: ok");
console.log("desktop-installer-private-env-excluded: ok");
console.log(`desktop-installer-sha256: ${sha256}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readPeSubsystem(bytes, label) {
  assert(bytes.subarray(0, 2).toString("ascii") === "MZ", `${label} is not a PE file`);
  const peOffset = bytes.readUInt32LE(0x3c);
  assert(bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), `${label} has an invalid PE header`);
  return bytes.readUInt16LE(peOffset + 24 + 68);
}

async function verifyExactPathCleanup(nodePath, cleanupExecutable) {
  const child = spawn(nodePath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  const exitPromise = once(child, "exit");
  try {
    await delay(300);
    assert(child.exitCode === null, "cleanup verification node did not start");
    const result = spawnSync(cleanupExecutable, ["--cleanup-installed-runtime", nodePath], {
      encoding: "utf8",
      windowsHide: true
    });
    assert(result.status === 0, `runtime cleanup command failed: ${result.stderr || result.stdout}`);
    assert(process.kill(process.pid, 0) === true, "runtime cleanup command stopped the verifier process");
    const exited = await Promise.race([
      exitPromise.then(() => true),
      delay(2_000).then(() => false)
    ]);
    assert(exited, "runtime cleanup command did not stop the exact-path test process");
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

function verifyMissingRuntimeCleanup(cleanupExecutable, missingNodePath) {
  const result = spawnSync(cleanupExecutable, ["--cleanup-installed-runtime", missingNodePath], {
    encoding: "utf8",
    windowsHide: true
  });
  assert(result.status === 0, "runtime cleanup must succeed when no previous bundled node exists");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
