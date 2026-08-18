import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const finalRuntimeRoot = join(repositoryRoot, "apps", "desktop", "src-tauri", "runtime");
const envTemplateSource = join(repositoryRoot, ".env.example");
const stagingRoot = join(tmpdir(), `personal-ai-assistant-runtime-${process.pid}`);
const runtimeRoot = join(stagingRoot, "runtime");

if (!existsSync(envTemplateSource)) {
  throw new Error("桌面独立发行版需要仓库根目录的 .env.example；未找到该文件，已停止打包。");
}

// Use the repository-pinned pnpm through Corepack. A global pnpm installation
// is intentionally not required for a clean Windows release build.
const pnpmCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
const pnpmEnvironment = { ...process.env, CI: "true" };
const runPnpm = (args) =>
  execFileSync(pnpmCommand, ["pnpm", ...args], {
    cwd: repositoryRoot,
    env: pnpmEnvironment,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

// Build before deploying. Keeping this explicit avoids recursively invoking the
// root build script and makes the API/Worker artifacts part of the release input.
for (const packageName of ["@personal-ai/domain", "@personal-ai/db", "@personal-ai/api", "@personal-ai/worker"]) {
  runPnpm(["--filter", packageName, "build"]);
}

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

const deploy = (packageName, outputDirectory) => {
  runPnpm(["deploy", "--legacy", "--filter", packageName, "--prod", outputDirectory]);
};

try {
  deploy("@personal-ai/api", join(stagingRoot, "api"));
  deploy("@personal-ai/worker", join(stagingRoot, "worker"));
} finally {
  // pnpm deploy temporarily changes the workspace install to production mode.
  // Always restore the development workspace, including after a failed deploy.
  runPnpm(["install"]);
}

const copyTreeDereferenced = (source, destination, ancestors = new Set()) => {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    const resolved = realpathSync(source);
    if (ancestors.has(resolved)) {
      throw new Error(`dependency symlink cycle while copying ${source}`);
    }
    return copyTreeDereferenced(resolved, destination, new Set([...ancestors, resolved]));
  }
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTreeDereferenced(join(source, entry), join(destination, entry), ancestors);
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
};

const copyFlatService = (service) => {
  const source = join(stagingRoot, service);
  const destination = join(runtimeRoot, service);
  mkdirSync(destination, { recursive: true });
  copyTreeDereferenced(join(source, "dist"), join(destination, "dist"));
  copyFileSync(join(source, "package.json"), join(destination, "package.json"));

  const sourceModules = join(source, "node_modules");
  const destinationModules = join(destination, "node_modules");
  mkdirSync(destinationModules, { recursive: true });
  for (const entry of readdirSync(sourceModules)) {
    if (entry === ".pnpm" || entry === ".modules.yaml" || entry === ".package-map.json") continue;
    copyTreeDereferenced(join(sourceModules, entry), join(destinationModules, entry));
  }

  // pnpm keeps transitive packages inside the virtual store. Flatten those
  // package directories too, because an installed Tauri resource cannot rely
  // on pnpm's symlink graph after the staging directory is removed.
  const virtualStore = join(sourceModules, ".pnpm");
  for (const packageEntry of readdirSync(virtualStore)) {
    const packageModules = join(virtualStore, packageEntry, "node_modules");
    if (!existsSync(packageModules)) continue;
    for (const dependencyEntry of readdirSync(packageModules)) {
      if (dependencyEntry === ".bin") continue;
      const dependencySource = join(packageModules, dependencyEntry);
      if (dependencyEntry.startsWith("@")) {
        for (const scopedEntry of readdirSync(dependencySource)) {
          const destination = join(destinationModules, dependencyEntry, scopedEntry);
          if (!existsSync(destination)) {
            copyTreeDereferenced(join(dependencySource, scopedEntry), destination);
          }
        }
      } else {
        const destination = join(destinationModules, dependencyEntry);
        if (!existsSync(destination)) {
          copyTreeDereferenced(dependencySource, destination);
        }
      }
    }
  }
};

copyFlatService("api");
copyFlatService("worker");

// `pnpm deploy` may omit package-owned files that are not part of the compiled
// output. The installed app runs guarded migrations before starting its API,
// so keep the complete Drizzle journal beside every deployed db package.
const migrationSource = join(repositoryRoot, "packages", "db", "drizzle");
for (const service of ["api", "worker"]) {
  const deployedDbPackage = join(runtimeRoot, service, "node_modules", "@personal-ai", "db");
  if (!existsSync(deployedDbPackage)) {
    throw new Error(`deployed ${service} runtime is missing @personal-ai/db`);
  }
  copyTreeDereferenced(migrationSource, join(deployedDbPackage, "drizzle"));
}

// The runtime is intentionally copied from the machine used to build this private
// single-user release, so the installed app does not depend on a system Node install.
// Never copy the builder's .env: installers must not contain database passwords or
// API keys. The app creates a user-owned config file from this template on first run.
copyFileSync(process.execPath, join(runtimeRoot, "node.exe"));
copyFileSync(envTemplateSource, join(runtimeRoot, ".env.example"));

rmSync(finalRuntimeRoot, { recursive: true, force: true });
mkdirSync(dirname(finalRuntimeRoot), { recursive: true });
renameSync(runtimeRoot, finalRuntimeRoot);
rmSync(stagingRoot, { recursive: true, force: true });

console.log("Prepared standalone desktop runtime:");
console.log(`  ${finalRuntimeRoot}`);
console.log("  Included Node, API, Worker, production dependencies, and local configuration.");
