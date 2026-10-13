# RadEAU

A high-performance automotive Ethernet network analysis tool — SOME/IP,
SOME/IP-SD, gPTP and DoIP, plus the standard protocols a bench NIC carries —
built to grow a no-decimation chart engine at its core.
**The plot is the product.**

- Product requirements: [PRD.md](PRD.md)
- Software specifications: [docs/](docs/) (`SRS_<functionality>.md`)
- Implementation plan: [PLAN.md](PLAN.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)

## Status

v0.1.x is a **bench build**: capture from a NIC (Npcap/libpcap), a pcap file,
a pcap stream or the simulator; read the trace like Wireshark (29 protocol
classes with layered dissection); decode SOME/IP payloads against an AUTOSAR
Ethernet communication extract; record pcapng and replay it with a transport
(play, pause, step, seek, 0.1×–10×); export the trace as decoded JSONL; and
let an AI agent drive all of it through the bundled MCP server (below). The
Signals chart engine, live topology and transmission are planned and show
honest empty states until they land — see the
[known limitations](CHANGELOG.md) for the current release.

## Download

Each [release](https://github.com/CynaCons/RadEAU/releases) ships:

- **Windows 10/11 x64** — `RadEAU-<version>-win64.zip`, portable (no
  installer): unzip and run `radeau.exe`; install
  [Npcap](https://npcap.com/#download) separately for live capture. See
  "Bench test on another machine" below for the contents and first-run steps.
- **Linux x64** — `RadEAU_<version>_amd64.AppImage` (`chmod +x`, run), plus
  `RadEAU-<version>-linux-x64.tar.gz` with the simulator, the replay fixture
  and the catalog extract. Live capture binds your distribution's `libpcap`
  at runtime and needs the usual packet-capture privileges. The Linux build
  is produced by CI and has had less bench time than the Windows one.

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a `v*` tag is pushed; the release body is that version's
[CHANGELOG.md](CHANGELOG.md) section.

## Stack

Tauri 2 (Rust core + WebView), React 19 + TypeScript + Vite, MUI (dark),
a planned custom WebGL2 chart engine with a wrapped Canvas2D fallback, and a
companion ECU network simulator (`ecu-netsim`) that generates a
PTP-synchronized SOME/IP sensor-fusion network for development, testing, and
demos.

## Canonical build

Exactly one supported command produces the shipping binary:

```
npm run tauri build
```

Development:

```
npm install
npm run tauri dev     # full app (Rust core + WebView)
npm run dev           # UI only, in a plain browser
```

## Running against the ECU network simulator

The companion simulator streams a PTP-synchronized SOME/IP sensor-fusion
network (camera, radar, lidar, dynamics, fusion) over a loopback monitor
link that the app consumes live:

```
cargo run -p ecu-netsim          # monitor link on 127.0.0.1:5560
npm run tauri dev                # in a second terminal
```

In the app: **Settings › Interface › Simulator link** (the address defaults
to `127.0.0.1:5560`), then **Start** from the app bar. Frames appear with
their source node names from the link handshake; the link chip in the Trace
header shows the link state. `--monitor-port` and `--seed` adjust the port and
the deterministic traffic; `--udp-target 127.0.0.1` additionally sends the
SOME/IP, SD and DoIP datagrams from real sockets so a live NIC or the Npcap
loopback adapter sees them. Debug builds default to the built-in **Dev
generator** source, which needs no external process; release builds default
to the physical interface when Npcap is installed, otherwise to pcap replay.

## Checks

```
npm run ci            # typecheck + unit tests + color lint + ID lint + dependency check
npm run test:e2e      # launches the real binary, asserts the UI is visible and streaming
npm run test:e2e:release  # after build:portable — release exe, no vite, pcap fixture
```

Note: a **debug** binary compiled by `npm run tauri dev` loads the vite dev
server (`localhost:1420`) and shows *Page not found* without it. For a
double-clickable executable use `npm run tauri build` (release, canonical),
`npm run build:portable` (zip for a work laptop — see below), or
`npm run build:debug` (debug profile with embedded assets, much faster —
note it recompiles `target/debug/radeau.exe` into standalone mode until the
next `tauri dev`).

## Agent access (MCP)

RadEAU is built to be driven by an AI agent as fully as by the operator: an
agent can start and stop capture on any source, record to pcapng, open a
recording and replay it (play, pause, step, seek, speed), and read the trace —
query rows with filters, fetch any frame's full dissection, get per-protocol
statistics, export decoded JSONL. Specification:
[docs/SRS_automation.md](docs/SRS_automation.md).

The running app serves a loopback automation endpoint (`127.0.0.1:5555`);
`radeau-mcp` (shipped next to `radeau` in the release zip / tarball, built with
`cargo build --release -p radeau-mcp`) is the MCP server an agent talks to over
stdio. Start RadEAU first, then register the bridge with your agent:

Claude Code:

```
claude mcp add radeau -- C:\path\to\RadEAU\radeau-mcp.exe
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.radeau]
command = 'C:\path\to\RadEAU\radeau-mcp.exe'
```

Any MCP client works the same way (`command` = the `radeau-mcp` binary, no
arguments). `RADEAU_AUTOMATION_PORT` overrides the port. Everything an agent
does shows up in the UI — the run control, the record switch and the replay
bar follow it, an **Agent** chip appears in the app bar while a client is
connected, and every call is written to `radeau.log`.

## Bench test on another machine

Download the release zip, or build one on a development PC (Node + Rust
required here only):

```
npm run build:portable
```

That produces `dist-portable/RadEAU-<version>-win64.zip` containing:

| File | Purpose |
|---|---|
| `radeau.exe` | Release app with embedded UI (no vite / `localhost:1420`) |
| `ecu-netsim.exe` | Local ECU network simulator |
| `sensor-fusion-5s.pcap` | Fixture for pcap-file replay |
| `sensor-fusion.arxml` | Catalog extract |
| `README-portable.md` | Target-machine instructions |

**Prerequisites on the bench machine (Windows 10/11):** WebView2 (already on
updated Windows) and [Npcap](https://npcap.com/#download) for live capture —
leave **"Restrict Npcap driver's access to Administrators only"** unchecked.
Vector VN hardware is not supported yet (planned); the Dependencies panel only
reports whether the XL Driver Library and driver package are installed.

**First-run checklist:** unzip → double-click `radeau.exe` → **Settings ›
Dependencies** (confirm Npcap) → **Settings › Interface** (Physical /
Simulator / pcap) → **Start** from the app bar → **Export** buffered frames
as pcap when you need to keep a capture.

Optional local demo without a bench NIC:

```
ecu-netsim.exe --monitor-port 5560 --udp-target 127.0.0.1
```

then choose **Simulator link** at `127.0.0.1:5560`.

**How to report a problem:** copy the **Settings › Diagnostics** report, attach
`%LOCALAPPDATA%\com.cynacons.radeau\logs\radeau.log`, and attach a pcap export
of the buffered frames when useful.

## License

[MIT](LICENSE)
