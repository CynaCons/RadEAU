# D10 — Recording format: pcapng frames, JSONL for events and decoded export

Status: Accepted · 2026-10-13 (supersedes the JSONL frame recording of PRD §6)

## Context

PRD §6 specified JSONL recordings (one decoded storage frame per line). Since
then the product direction became AI-first (PLAN v0.1.13–v0.1.16): an agent
records, replays and reads the bus through RadEAU's MCP tools. Two consumers
matter for a recording file: RadEAU itself (replay, analysis, agents through
the MCP), and the bench engineer's existing tools (Wireshark, tshark, CANoe).
RadEAU already writes classic pcap from the raw wire bytes in the core
(SRS_capture §7) and reads pcap/pcapng (§2).

## Decision

- **Frame recordings are pcapng**, written by the core from the raw wire
  bytes (never from the UI's JSON): a Section Header Block naming RadEAU and
  carrying the session metadata as a comment, one Interface Description Block
  per source (Ethernet, ns resolution), one Enhanced Packet Block per frame
  with its ns timestamp and direction flags. Wireshark opens them unchanged.
- **The network timestamp is the EPB timestamp**: the session's timestamp
  source (simulator switch time, NIC capture time, original file time on
  replay) is what is written, at ns resolution, so a replay reproduces it.
- **JSONL stays the format for events** (the core log, CP-007) **and for the
  decoded export** — one object per frame with the same dissection the UI and
  the MCP show — for agents and grep, produced on demand from the ring or a
  recording.

## Consequences

- No second frame-recording format to maintain; replay, analysis and agents
  read one format, and engineers keep their Wireshark workflow.
- Decoded names live in the export and the MCP answers, not in the recording:
  a recording made before a catalog was loaded decodes with today's catalog.
- PRD §6 is amended (recordings are pcapng; JSONL for events and export).
- Reopen if agents need per-frame data the pcapng cannot carry (then: pcapng
  custom options, not a parallel format).
