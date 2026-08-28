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

Performed once, in the reader: EtherType (0x0800 IPv4, 0x88F7 gPTP, 0x0806
ARP), optional 802.1Q tag, IPv4 + UDP headers, SD by its fixed service/method
identity (0xFFFF / 0x8100), SOME/IP by catalog port and header plausibility.
Malformed frames classify as `other` with a per-frame diagnostic — never a
panic, never a silent drop.

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
