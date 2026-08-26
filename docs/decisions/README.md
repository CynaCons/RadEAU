# Decision records

Architecture decision records for the decisions enumerated in
[PRD.md](../../PRD.md) §11. One file per decision; each is written before the
affected subsystem is built.

- [D1 — Renderer memory strategy](D1-renderer-memory.md) — workers + transferable/shared buffers, hot data out of the JS heap; revisit only if the overnight slope gates fail.
- [D2 — No-decimation ceiling](D2-decimation-ceiling.md) — raw-only rendering in v1 within documented caps; hybrid envelope reserved as a versioned extension.
- [D3 — Timebase](D3-timebase.md) — application arrival timebase (u32 ms, monotonic) for pacing; network timestamp (ns) a first-class optional recording field from v1.
- [D4 — Keep-alive views](D4-keep-alive-views.md) — mount-once keep-alive kept, with a mandatory suspend/resume contract per view from first commit.
- [D5 — IPC transport for frame batches](D5-ipc-transport.md) — binary/structured-clone over shared memory adopted provisionally; must be confirmed before the first frame consumer.
- [D6 — Network observation model](D6-network-observation.md) — simulator virtual-switch monitor link first; Npcap/libpcap capture later behind the same channel API.
- [D7 — Service catalog format](D7-catalog-format.md) — native versioned YAML first; ARXML/FIBEX import later, targeting the same in-memory model.
- [D8 — PTP simulation depth](D8-ptp-depth.md) — gPTP two-step with modeled clocks and a simple servo; static grandmaster; no BMCA or TSN shaping in v1.
- [D9 — Simulator delivery](D9-simulator-delivery.md) — Rust crate + standalone binary in the same workspace, sharing the protocol codec crates with the core.
