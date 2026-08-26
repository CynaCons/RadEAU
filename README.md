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

## Checks

```
npm run ci            # typecheck + unit tests + color lint + ID lint + dependency check
```

## License

[MIT](LICENSE)
