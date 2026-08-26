# RadEAU

A high-performance automotive Ethernet network analysis tool — SOME/IP,
SOME/IP-SD, and gPTP — with a no-decimation chart engine at its core.
**The plot is the product.**

- Product requirements: [PRD.md](PRD.md)
- Software specifications: [docs/](docs/) (`SRS_<functionality>.md`)
- Implementation plan: [PLAN.md](PLAN.md)

## Stack

Tauri 2 (Rust core + WebView), React 19 + TypeScript + Vite, MUI (dark),
custom WebGL2 chart engine with a wrapped Canvas2D fallback, and a companion
ECU network simulator (`ecu-netsim`) that generates a PTP-synchronized
SOME/IP sensor-fusion network for development, testing, and demos.

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

In the app: **Trace → Source: Simulator link → ▶** (the address field
defaults to `127.0.0.1:5560`). Frames appear with their source node names
from the link handshake; the chip next to the picker shows the link state.
`--monitor-port` and `--seed` adjust the port and the deterministic traffic.
The **Dev generator** source needs no external process and remains the
default.

## Checks

```
npm run ci            # typecheck + unit tests + color lint + ID lint + dependency check
npm run test:e2e      # launches the real binary, asserts the UI is visible and streaming
```

Note: a **debug** binary compiled by `npm run tauri dev` loads the vite dev
server (`localhost:1420`) and shows *Page not found* without it. For a
double-clickable executable use `npm run tauri build` (release, canonical) or
`npm run build:debug` (debug profile with embedded assets, much faster —
note it recompiles `target/debug/radeau.exe` into standalone mode until the
next `tauri dev`).

## License

[MIT](LICENSE)
