/**
 * Portable bench zip — vite release assets + release binaries + fixture +
 * catalog + README, packed for a bench machine with no toolchain.
 *
 * Run: npm run build:portable
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readVersion() {
  const conf = JSON.parse(
    readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf-8"),
  );
  return String(conf.version);
}

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell: true,
      stdio: "inherit",
      windowsHide: true,
      ...opts,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function portableReadme(version) {
  return `# RadEAU ${version} — portable bench build (Windows x64)

This folder is a self-contained RadEAU bench kit. Copy the whole zip to a
Windows 10/11 laptop, unzip, and run — no Node, Rust, or Visual Studio
required on the target machine.

## What's in the zip

| File | Purpose |
|---|---|
| \`radeau.exe\` | RadEAU release app (embeds the UI; no vite / localhost:1420) |
| \`ecu-netsim.exe\` | Companion ECU network simulator for a local demo |
| \`sensor-fusion-5s.pcap\` | Short fixture for Settings › Interface › pcap file replay |
| \`sensor-fusion.arxml\` | Sensor-fusion service catalog extract |
| \`README-portable.md\` | This file |

## Prerequisites

1. **Windows 10/11** with the **WebView2** runtime (present on any updated
   Windows 11 / recent Windows 10).
2. **Npcap** for live NIC capture — download from
   https://npcap.com/#download. During install, leave
   **"Restrict Npcap driver's access to Administrators only"** **unchecked**
   so a normal user session can open adapters.
3. **Vector VN hardware is not supported yet** (planned). The Dependencies
   panel already reports whether the XL Driver Library and the Vector driver
   package are installed so the bench can be prepared ahead of that release.

## How to run

1. Double-click \`radeau.exe\`.
2. Optional local demo without a bench: in a terminal next to these files,
   \`\`\`
   ecu-netsim.exe --monitor-port 5560 --udp-target 127.0.0.1
   \`\`\`
   then in RadEAU set **Settings › Interface › Simulator link** to
   \`127.0.0.1:5560\` and Start from the app bar.
3. Or replay the bundled fixture: **Settings › Interface › pcap file**, browse
   to \`sensor-fusion-5s.pcap\` in this folder, pace **fast**, then Start.

## First-run checklist

1. **Settings › Dependencies** — confirm Npcap (and Vector rows if relevant).
2. **Settings › Interface** — pick Physical interface / Simulator link / pcap.
3. **Start** from the app bar (Trace / Network will show frames).
4. **Export** buffered frames as pcap from Recorder / the export action when
   you need a capture to keep.

## Diagnostics and the log

- **Settings › Diagnostics** — pasteable report (build, OS, deps, recent
  warnings). Use **Copy**.
- On-disk log:
  \`%LOCALAPPDATA%\\com.cynacons.radeau\\logs\\radeau.log\`

## How to report a problem

1. Copy the **Diagnostics** report text.
2. Attach \`radeau.log\` from the path above.
3. Export the buffered frames as a \`.pcap\` (when the session had useful
  traffic) and attach that too.

Build profile of this package: **release** (the Dev generator source is not
available).
`;
}

async function zipFolder(folderPath, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  if (platform() === "win32") {
    // Compress-Archive wants a wildcard / path; -Force overwrites.
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${folderPath}\\*' -DestinationPath '${zipPath}' -Force`,
    ]);
  } else {
    const parent = dirname(folderPath);
    const base = folderPath.split(/[/\\]/).pop();
    await run("zip", ["-r", zipPath, base], { cwd: parent });
  }
}

async function main() {
  const version = readVersion();
  const folderName = `RadEAU-${version}-win64`;
  const outRoot = join(repoRoot, "dist-portable");
  const outDir = join(outRoot, folderName);
  const zipPath = join(outRoot, `${folderName}.zip`);

  console.log(`portable build ${version} → ${outDir}`);

  // `tauri build --no-bundle` runs beforeBuildCommand (vite) and compiles the
  // release binary with embedded frontendDist. Bare `cargo build -p radeau`
  // can leave a prior `tauri dev` cfg(dev) fingerprint and still open
  // localhost:1420 — the CLI path is what actually embeds the UI.
  console.log("1/3 tauri build --no-bundle (vite + release radeau)…");
  try {
    await run("npx", ["tauri", "build", "--no-bundle"]);
  } catch (err) {
    console.warn("tauri build failed — stopping locked radeau and retrying once…");
    try {
      await run("powershell", [
        "-NoProfile",
        "-Command",
        "Stop-Process -Name radeau,ecu-netsim -Force -ErrorAction SilentlyContinue",
      ]);
    } catch {
      /* ignore */
    }
    await run("npx", ["tauri", "build", "--no-bundle"]);
  }

  console.log("2/3 cargo build --release -p ecu-netsim…");
  try {
    await run("cargo", ["build", "--release", "-p", "ecu-netsim"]);
  } catch (err) {
    console.warn("ecu-netsim build failed — stopping locked process and retrying once…");
    try {
      await run("powershell", [
        "-NoProfile",
        "-Command",
        "Stop-Process -Name ecu-netsim -Force -ErrorAction SilentlyContinue",
      ]);
    } catch {
      /* ignore */
    }
    await run("cargo", ["build", "--release", "-p", "ecu-netsim"]);
  }

  const radeauExe = join(repoRoot, "target", "release", "radeau.exe");
  const netsimExe = join(repoRoot, "target", "release", "ecu-netsim.exe");
  const pcap = join(repoRoot, "fixtures", "pcap", "sensor-fusion-5s.pcap");
  const arxml = join(repoRoot, "catalog", "sensor-fusion.arxml");
  for (const p of [radeauExe, netsimExe, pcap, arxml]) {
    if (!existsSync(p)) throw new Error(`missing required artifact: ${p}`);
  }

  console.log("3/3 assemble zip…");
  mkdirSync(outRoot, { recursive: true });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  copyFileSync(radeauExe, join(outDir, "radeau.exe"));
  copyFileSync(netsimExe, join(outDir, "ecu-netsim.exe"));
  copyFileSync(pcap, join(outDir, "sensor-fusion-5s.pcap"));
  copyFileSync(arxml, join(outDir, "sensor-fusion.arxml"));
  writeFileSync(join(outDir, "README-portable.md"), portableReadme(version), "utf-8");

  await zipFolder(outDir, zipPath);
  console.log(`OK ${zipPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
