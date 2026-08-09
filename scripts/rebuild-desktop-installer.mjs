import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(repositoryRoot, "apps", "desktop", "src-tauri");
const tauriConfig = JSON.parse(readFileSync(join(tauriRoot, "tauri.conf.json"), "utf8"));
const generatedDirectory = join(tauriRoot, "target", "release", "nsis", "x64");
const generatedInstaller = join(generatedDirectory, "installer.nsi");
const nsisOutput = join(generatedDirectory, "nsis-output.exe");
const finalInstaller = join(
  tauriRoot,
  "target",
  "release",
  "bundle",
  "nsis",
  `Personal AI Assistant_${tauriConfig.version}_x64-setup.exe`
);
const makensis = join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "Bin", "makensis.exe");

for (const path of [generatedInstaller, makensis]) {
  if (!existsSync(path)) throw new Error(`desktop installer rebuild input is missing: ${path}`);
}

const originalSource = readFileSync(generatedInstaller, "utf8");
const lineEnding = originalSource.includes("\r\n") ? "\r\n" : "\n";
let source = originalSource.replaceAll("\r\n", "\n");
const pageMarker = "Function PageReinstall\n";
const contextMarker = "  !insertmacro SetContext\n\n  ${If} $INSTDIR == \"${PLACEHOLDER_INSTALL_DIR}\"";
if (
  occurrences(source, pageMarker) !== 1
  || occurrences(source, contextMarker) !== 1
  || source.includes("PERSONAL_AI_SAFE_IN_PLACE_UPGRADE")
) {
  throw new Error("generated NSIS template changed; safe in-place upgrade patch was not applied");
}

source = source.replace(
  pageMarker,
  [
    "Function PageReinstall",
    "  ; PERSONAL_AI_SAFE_IN_PLACE_UPGRADE: /UPDATE skips the old uninstaller.",
    "  ${If} $UpdateMode = 1",
    "    Abort",
    "  ${EndIf}",
    ""
  ].join("\n")
);
source = source.replace(
  contextMarker,
  [
    "  !insertmacro SetContext",
    "",
    "  ; PERSONAL_AI_SAFE_IN_PLACE_UPGRADE: an existing NSIS install is overwritten",
    "  ; only after the new installer has stopped and replaced its bundled runtime.",
    "  ReadRegStr $R7 SHCTX \"${UNINSTKEY}\" \"UninstallString\"",
    "  ${If} $R7 != \"\"",
    "    StrCpy $UpdateMode 1",
    "  ${EndIf}",
    "",
    "  ${If} $INSTDIR == \"${PLACEHOLDER_INSTALL_DIR}\""
  ].join("\n")
);

writeFileSync(generatedInstaller, source.replaceAll("\n", lineEnding), "utf8");
rmSync(nsisOutput, { force: true });
const result = spawnSync(makensis, [generatedInstaller], {
  cwd: generatedDirectory,
  encoding: "utf8",
  windowsHide: true
});
if (result.status !== 0 || !existsSync(nsisOutput)) {
  throw new Error(`safe desktop installer rebuild failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}
copyFileSync(nsisOutput, finalInstaller);
console.log(`Rebuilt safe in-place desktop installer: ${finalInstaller}`);

function occurrences(value, marker) {
  return value.split(marker).length - 1;
}
