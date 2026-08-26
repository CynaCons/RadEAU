# RadEAU — Architecture Overview (diagrams)

Diagram companion to the normative documents — [PRD.md](../PRD.md) §3–§4,
[SRS_streaming.md](SRS_streaming.md), [SRS_protocols.md](SRS_protocols.md),
[SRS_ecu_netsim.md](SRS_ecu_netsim.md). Where this page and those documents
disagree, the documents win.

## 1. Current data path (v0.1.x — as built)

One pipeline slice exists end to end today. Its **source is the dev frame
generator (PRD §3.8), wired directly into the capture module** — a deliberate
temporary shortcut: the channel abstraction it will move behind arrives in
v0.3.1. Everything downstream of the accumulator is already the real,
spec-shaped pipeline (PF-001..004 implemented and tested).

```mermaid
flowchart LR
  subgraph core["Rust core (radeau.exe)"]
    devgen["DevGen\nseeded SOME/IP · SD · gPTP\nsynthetic frames"]
    emitter["devgen-emitter thread\nrate profile → frames"]
    acc["Accumulator\n4,000 cap · drop oldest"]
    cadence["Deadline cadence 16 ms\n+ credits (3 in flight)"]
    devgen --> emitter --> acc --> cadence
  end

  subgraph ui["WebView UI"]
    store["traceStore\n(bounded row store)"]
    trace["Trace view\n(virtualized table)"]
    ack["1 ack / animation frame"]
    store --> trace
    trace -.-> ack
  end

  cadence -- "frames:batch\n(columnar event)" --> store
  ack -- "ack_frames" --> cadence
  ui -- "capture_start / capture_stop" --> core

  subgraph netsim["ecu-netsim (skeleton binary)"]
    ns["NOT CONNECTED YET\narrives v0.4"]
  end
  netsim ~~~ core
```

In a plain browser (no Tauri), a TypeScript mirror of the generator
(`devGenMirror.ts`) emits the identical `frames:batch` shape on the identical
cadence, so every view behaves the same in browser-mode development and E2E.

## 2. Target unified pipeline (specified; lands v0.3 → v0.4)

**One channel abstraction, one reader, one source of truth** (PRD §3.2, §3.5).
Every frame source — a real Ethernet interface, the simulator, the in-process
loopback, the dev generator — is a backend behind the same compile-time channel
API. Exactly one **capture reader thread** owns the RX side by move; it is the
single place where frames are timestamped, classified, recorded, and batched.
Nothing downstream knows or cares which backend produced a frame.

```mermaid
flowchart LR
  subgraph sources["Channel backends (one uniform API: open · read · write · status)"]
    sim["Simulator link\nTCP 5560 monitor+inject\n(default dev channel)"]
    pcap["Npcap / libpcap\nreal Ethernet interface\n(backlog)"]
    loop["Loopback\npseudo-channel\n8192-frame echo"]
    dev["Dev generator\n(runtime-gated fixture)"]
  end

  subgraph netsim["ecu-netsim process"]
    switch["Virtual switch\nns-timestamped frames"]
    ecus["Simulated ECUs\ncamera · radar · lidar\ndynamics · fusion\nSOME/IP + SD + gPTP"]
    ctl["Control JSON-RPC :5561\nscenario · faults"]
    ecus --- switch
  end
  switch -- "monitor stream" --> sim
  sim -- "inject" --> switch

  subgraph core["Rust core — single source of truth"]
    reader["Capture reader thread\n(owns RX by move)\nstamp · classify · resolve"]
    snap["RX snapshot\n(latest per key)"]
    rec["Recording writer\nJSONL · 256 KB/2 s"]
    accT["Accumulator + cadence\n+ credit backpressure"]
    reader --> snap
    reader --> rec
    reader --> accT
  end
  sources --> reader

  replay["Replay worker\npaced JSONL recording\n(source label: replay)"] --> reader
  log["Core event log\nJSONL · rotated"]
  reader --> log

  subgraph surfaces["Remote surfaces (the automation plane)"]
    auto["Automation JSON-RPC :5555\nUI-verb parity · ghost user\nsignal subscriptions"]
    nodes["Node plane :5562\nexternal nodes inject/receive\norigin-tagged · no echo\nto the originator"]
    runner["Script runner\n(Python, observes via :5555)"]
  end
  core <--> auto
  nodes <--> reader
  runner --> auto

  subgraph ui["WebView UI"]
    views["Trace · Network · Signals\nRecorder · Simulation · …"]
  end
  accT -- "frames:batch" --> views
  views -- "commands / acks" --> core
  views -- "transmit / inject" --> reader
```

Key consequences:

- **Source transparency.** Switching from `ecu-netsim` to a real NIC (or
  replaying a recording) changes which backend the reader polls — nothing else.
  Views, recording, automation clients, and tests see identical behavior.
- **The reader is the only writer** of the RX snapshot, the recording, and the
  emit accumulator. There is no second path for frames into the system;
  injected/transmitted frames enter through the channel `write` and come back
  as observed traffic like everything else.
- **Four frame-source classes, one pipeline**: channel RX (simulator or a real
  NIC), replay files, the UI's Simulation view, and external nodes on the node
  plane (:5562). Every frame carries a source label + originating node id
  (PRD §3.4) shown in Trace; fan-out reaches every sink **except the frame's
  originator** — Node A never receives what Node A sent (PRD §8.3).
- **Replay** substitutes the reader's source with the paced recording worker but
  reuses the same batched/backpressured emit path (`replay` source label).
- **Everything on disk is JSONL** — frame recordings and the core event log
  alike; the hot-path IPC batch is deliberately not JSON-encoded per frame
  (decision D5).

## 3. Automation and SIL layering (v0.6–v0.7 surfaces)

The SIL story is the **ghost-user principle** (PRD §1.1-4): a script drives the
same verbs the operator drives, against the same core, over the same unified
pipeline — plus fault control over the simulated plant.

```mermaid
sequenceDiagram
  participant T as Test script / CI (SIL client)
  participant A as Automation :5555 (RadEAU core)
  participant P as Unified pipeline (reader → stores)
  participant C as ecu-netsim control :5561
  participant N as Simulated network (plant)

  T->>A: start capture (channel = simulator link)
  A->>P: session start — reader owns RX
  N-->>P: SOME/IP · SD · gPTP frames (via monitor link)
  T->>A: subscribe FusedObjects.vx (decoded, scaled)
  A-->>T: coalesced signal updates
  T->>C: fault: drop_events(RadarTargets, 50)
  C->>N: fault applied to plant
  N-->>P: degraded traffic (observable)
  A-->>T: fused-signal deviation visible in subscription
  T->>A: stop capture · fetch evidence
```

Both surfaces enforce the same posture: loopback bind by default; external bind
requires token + allowlist or startup rejection (PRD §8.1).

## 4. Where the pieces land in the plan

| Piece | Iteration |
|---|---|
| Channel abstraction + loopback + stub backends | v0.3.1 |
| Protocol codecs shared by app and simulator (`radeau-proto`) | v0.3.0 (crate exists; framing layer landed) |
| `ecu-netsim` virtual switch + monitor/inject link + simulator-link backend | v0.4.0 |
| SOME/IP + SD runtimes, gPTP, fusion scenario, fault verbs | v0.4.1–v0.4.2 |
| Live decode + Trace/Network/Signals on real traffic | v0.5 |
| Transmission + automation surface (:5555), script runner | v0.7 |
