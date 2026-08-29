# SRS — Protocol Codecs and Decode

**Scope:** Wire formats and decode rules — Ethernet/IPv4/UDP parsing, the
SOME/IP header, protocol classification, the service catalog, and the
dual-decoder contract. Runtime behavior of the simulated network lives in
[SRS_ecu_netsim.md](SRS_ecu_netsim.md); the SP- requirement rows live there too
and this document is their normative elaboration. Product context:
[PRD.md](../PRD.md) §3.4. ID prefix: `SP-` (shared with SRS_ecu_netsim.md; one
allocator).

---

## 1. Frame representations

Two frame representations, never conflated:

- **Storage frame** (internal + recordings): arrival timestamp (u32 ms), optional
  network timestamp (u64 ns), channel, direction (rx/tx), raw frame bytes up to a
  snap length (default 1,522 — full frame with one VLAN tag), optional decoded
  service/method names, optional source label (`capture` default | `replay` |
  `simulation` | `injection` | `remote`), optional originating client id/name.
  Recordings stay self-describing.
- **Wire frame** (IPC only): arrival ms, channel, direction, one-byte protocol
  classification (SOME/IP, SOME/IP-SD, gPTP, ARP, other-UDP, other), compact
  endpoint tuple (src/dst IPv4 + ports), the parsed SOME/IP header when present
  (service, method, length, client, session, message type, return code), payload
  bytes (omitted when empty), optional network timestamp. Names are dropped; the
  UI reconstructs them from a memoized (service id, method id) → name map.
  Recording format and wire format evolve independently.

## 2. Protocol classification

Performed once, in the reader, for every frame a source delivers.
Classification **never drops** (SP-006): each frame receives exactly one
protocol class and is retained in the frame buffer (§3b) so it can be
dissected. Order:

1. Ethernet II header — fewer than 14 bytes → `Malformed` (the frame is still
   retained and shown).
2. 802.1Q / 802.1ad tags peeled, one or two (SP-007): the outer VLAN id is
   carried; the inner EtherType classifies.
3. EtherType 0x88F7 → `gPTP`, message type from the PTP header (Sync,
   Follow_Up, Pdelay_Req/Resp/Resp_Follow_Up, Announce, Signaling);
   0x0806 → `ARP` (opcode); 0x86DD → `IPv6` (next header); 0x0800 → IPv4
   by protocol: 17 → UDP (step 4), 6 → `TCP` (ports, flags), 1 → `ICMP`
   (type, code), anything else → `IPv4` (protocol number); any other
   EtherType → `Other` (EtherType carried).
4. UDP: `SD` by the fixed identity 0xFFFF / 0x8100; otherwise `SOME/IP` when
   the payload is **plausible** on **any** port (SP-008) — at least 16 bytes,
   protocol version 0x01, Length between 8 and (datagram payload − 8), message
   type in {0x00, 0x01, 0x02, 0x80, 0x81}; port 30490 is a fast path, never a
   gate, because real stacks carry events on SD-announced ports. Anything else
   → `UDP` (ports). Port 13400 is reserved for `DoIP` (v0.1.9).

A failure inside an upper header keeps the outer class (an unparseable
SOME/IP header on UDP classifies as `UDP`) and the dissection states where
parsing stopped. Several SOME/IP messages in one datagram classify on the
first; the dissector walks the rest.

**Direction** is relative to RadEAU's host (SP-009): **Rx** — observed on the
wire and not originated here (every frame on a mirror port, a tap, or the
simulator monitor link); **Tx** — originated by RadEAU (injection/transmit,
and the dev generator's synthesized transmit share); **unknown** — the source
cannot say (a pcap file without direction metadata). The UI renders unknown
as "—", never as a guessed Rx. The simulator monitor record's direction byte
describes the virtual switch's port side, not RadEAU; every monitor frame is
Rx until RadEAU injects (v0.7).

**Endpoint identity** is by address: the reader keeps a per-session endpoint
table keyed by source IPv4 (IP frames) or source MAC (non-IP frames),
assigning indexes on first sight and re-emitting `capture:session` whenever
the table grows; the last index is an overflow bucket once the table is full.
Names come from the source when it knows them (simulator handshake port
names), otherwise the address itself. The dev generator keeps its fixed table.

### 2b. Wire columns (IPC contract)

The columnar `frames:batch` event, the per-class meaning of the identity
columns, and every code table are pinned in `src-tauri/src/codes.rs`,
mirrored byte-for-byte by `src/runtime/wireCodes.ts`; a unit test reads the
Rust file and pins both sides. Beyond the original columns the batch carries
source/destination IPv4, source MAC, VLAN id, and the payload offset, so the
UI never re-derives header lengths.

**Capture statistics** (SP-010): a `capture:stats` event at 1 Hz while a
session runs and once at stop — frames received from the source, emitted to
the UI, dropped by the bounded accumulator, gap records and frames lost in
gaps, malformed frames, kernel-side drops (0 until the live backend), and a
per-class count vector — so a quiet bus and a discarding tool can never be
confused. Reader diagnostics never rely on stdout (the binary has no console).

## 3. SOME/IP header (normative)

Message ID = Service ID (u16) + Method ID (u16, high bit set for
events/notifications); Length (u32, covering Request ID through end of
payload); Request ID = Client ID (u16) + Session ID (u16, increments 1→0xFFFF,
wraps to 1); Protocol Version (0x01); Interface Version; Message Type (0x00
REQUEST, 0x01 REQUEST_NO_RETURN, 0x02 NOTIFICATION, 0x80 RESPONSE, 0x81 ERROR);
Return Code (0x00 E_OK, …). All multi-byte fields big-endian.

## 3b. Frame dissection service (cold path)

The core retains recent raw frames in a **bounded frame buffer** (capped by
frame count and total bytes, drop-oldest, kept across session stop until the
next start so a stopped trace stays inspectable). On demand — never on the
streaming path — the core dissects one buffered frame into an ordered layer
tree: per layer, the protocol name, a one-line summary, and the header fields
(name, display value, byte offset, length) exactly as the shared codecs parse
them, plus the full frame bytes. Malformed regions dissect as far as the
codecs reach and state the failure per layer; an evicted frame returns a
distinct "no longer buffered" error. One dissector, core-side, built on the
same codecs as classification (decision D9) — the UI never re-parses wire
bytes.

## 4. Service catalog

The service catalog (native YAML, versioned schema) defines services (id, name,
interface version), their methods, events, eventgroups, cycle-time
expectations, and payload layouts with scaling and units. It is parsed once at
load into precomputed lookups — (service) → name, (service, method) → payload
schema, eventgroup maps, value-table index — built in one pass. An atomic
catalog version counter bumps per load; downstream caches compare and rebuild
without locking the read path.

**AUTOSAR Ethernet Communication Extract (first-class import).** The
sensor-fusion network ships as a real ARXML communication extract — SOME/IP
service-interface deployment, socket-address and socket-connection
configuration, PDU triggering — checked into the repo as the reference
definition of the simulated network. The ARXML importer maps it into the same
in-memory catalog model that native YAML targets, so downstream consumers
(decoders, netsim, Network view) cannot tell which format loaded the catalog.
Import diagnostics are per-element (skipped-with-reason), never
all-or-nothing. FIBEX remains a backlog importer against the same model.

## 5. Payload decode and the dual-decoder contract

Payload decode is specified exactly because **two independent decoders must
agree bit for bit**: the core decodes for replay bulk fetch / automation, and
the UI decodes the live hot path locally (per-frame IPC round-trips are
forbidden).

v1 layout model: fixed-position fields — base types u8–u64, i8–i64, f32, f64 at
byte offsets, big-endian by default with a per-service byte-order override,
plus optional MSB0 bit slices (byte offset + bit offset + width) for packed
flags; physical = raw × factor + offset in f64. A payload shorter than a
field's extent yields *missing* for that signal — never a partial value, never
a panic. Dynamic arrays / strings / TLV are deferred with the catalog schema
versioned to admit them.

Both decoders are driven by one shared corpus of checked-in test vectors
covering floats, signed widths at sign-extension boundaries, bit slices, byte
straddles, and truncated payloads. UI decode uses plain-number bit math for
≤ 53-bit fields (~100× faster than bignum), arbitrary precision above; watch
32-bit shifts in JS (mod-32 wrap).
