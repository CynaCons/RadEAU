import { describe, expect, it } from "vitest";

import type { TraceFrame } from "./frameModel";
import { projectDisplayRows } from "./traceDisplay";
import {
  applyFilter,
  distinctValues,
  EMPTY_FILTER,
  isFilterActive,
  matches,
  nameFilterId,
  serviceMethodId,
  type TraceFilter,
  windowSequentialFiltered,
} from "./traceFilter";
import {
  DNS_TY_QUERY,
  DOIP_TY_DIAG,
  DOIP_TY_VEHICLE_ANNOUNCE,
  HTTP_TY_REQUEST,
  PROTO_DNS,
  PROTO_DOIP,
  PROTO_GPTP,
  PROTO_HTTP,
  PROTO_ICMPV6,
  PROTO_LLDP,
  PROTO_SD,
  PROTO_SOMEIP,
  PROTO_TLS,
} from "./wireCodes";

function row(
  partial: Partial<TraceFrame> & Pick<TraceFrame, "id" | "protocol" | "source" | "key">,
): TraceFrame {
  return {
    tS: 0,
    time: "0.0000",
    dir: "rx",
    sourceTitle: partial.source,
    serviceMethod: "0x1101:0x8001",
    name: "CameraObjects.ObjectList",
    type: "Notification",
    session: "--",
    length: "100",
    payload: "DE AD",
    deltaGlobal: "--",
    deltaKey: "--",
    channel: "1",
    proto: PROTO_SOMEIP,
    sv: 0x1101,
    m: 0x8001,
    srcEp: 0,
    ty: 0,
    se: -1,
    sa: 0,
    da: 0,
    sm: 0,
    vl: -1,
    ...partial,
  };
}

describe("isFilterActive / applyFilter fast path", () => {
  it("EMPTY_FILTER is inactive and applyFilter returns the same reference", () => {
    const rows = [
      row({ id: 1, protocol: "SOME/IP", source: "a", key: "0:4353:32769" }),
    ];
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(applyFilter(rows, EMPTY_FILTER)).toBe(rows);
  });

  it("any non-null column makes the filter active", () => {
    expect(isFilterActive({ ...EMPTY_FILTER, protocols: new Set([PROTO_GPTP]) })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, dirs: new Set() })).toBe(true);
  });
});

describe("matches — per column", () => {
  const base = row({
    id: 1,
    protocol: "SOME/IP",
    source: "a",
    key: "0:4353:32769",
    proto: PROTO_SOMEIP,
    sv: 0x1101,
    m: 0x8001,
    dir: "rx",
    name: "CameraObjects.ObjectList",
    serviceMethod: "0x1101:0x8001",
  });

  it("filters by service id pair", () => {
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      services: new Set(["4353:32769"]),
    };
    expect(matches(base, f)).toBe(true);
    expect(matches({ ...base, sv: 0x1102, m: 0x8001 }, f)).toBe(false);
  });

  it("filters by name via the same id pair (not the display string)", () => {
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      names: new Set(["4353:32769"]),
    };
    expect(matches(base, f)).toBe(true);
    expect(matches({ ...base, name: "Renamed.ByCatalog" }, f)).toBe(true);
    expect(matches({ ...base, sv: 0x1103 }, f)).toBe(false);
  });

  it("filters by protocol integer", () => {
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_GPTP]),
    };
    expect(matches(base, f)).toBe(false);
    expect(matches({ ...base, proto: PROTO_GPTP, protocol: "gPTP" }, f)).toBe(true);
  });

  it("filters by direction", () => {
    const f: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["tx"]) };
    expect(matches(base, f)).toBe(false);
    expect(matches({ ...base, dir: "tx" }, f)).toBe(true);
  });

  it("empty Set matches nothing", () => {
    const f: TraceFilter = { ...EMPTY_FILTER, protocols: new Set() };
    expect(matches(base, f)).toBe(false);
  });
});

describe("distinctValues", () => {
  it("keys Service and Name by sv:m and lists display labels with counts", () => {
    const rows = [
      row({
        id: 1,
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        sv: 0x1101,
        m: 0x8001,
        serviceMethod: "0x1101:0x8001",
        name: "CameraObjects.ObjectList",
      }),
      row({
        id: 2,
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        sv: 0x1101,
        m: 0x8001,
        serviceMethod: "0x1101:0x8001",
        name: "CameraObjects.ObjectList",
      }),
      row({
        id: 3,
        protocol: "SOME/IP",
        source: "b",
        key: "0:4355:32769",
        sv: 0x1103,
        m: 0x8001,
        serviceMethod: "0x1103:0x8001",
        name: "LidarClusters.ClusterList",
      }),
    ];
    const services = distinctValues(rows, "service");
    expect(services).toEqual([
      { key: "4353:32769", label: "0x1101:0x8001", count: 2 },
      { key: "4355:32769", label: "0x1103:0x8001", count: 1 },
    ]);
    const names = distinctValues(rows, "name");
    expect(names.map((o) => o.key)).toEqual(["4353:32769", "4355:32769"]);
    expect(names.find((o) => o.key === "4355:32769")?.label).toBe(
      "LidarClusters.ClusterList",
    );
  });

  it("lists protocols by PROTO_* key and dirs by dir string", () => {
    const rows = [
      row({ id: 1, protocol: "gPTP", source: "a", key: "2:1:0", proto: PROTO_GPTP, dir: "rx" }),
      row({ id: 2, protocol: "SD", source: "b", key: "1:2", proto: PROTO_SD, dir: "tx" }),
      row({ id: 3, protocol: "gPTP", source: "a", key: "2:1:0", proto: PROTO_GPTP, dir: "rx" }),
    ];
    expect(distinctValues(rows, "protocol")).toEqual([
      { key: String(PROTO_SD), label: "SD", count: 1 },
      { key: String(PROTO_GPTP), label: "gPTP", count: 2 },
    ]);
    expect(distinctValues(rows, "dir")).toEqual([
      { key: "rx", label: "Rx", count: 2 },
      { key: "tx", label: "Tx", count: 1 },
    ]);
  });
});

describe("projectDisplayRows + filter", () => {
  it("Fixed shows the latest matching frame per key (not the absolute newest)", () => {
    const rows = [
      row({
        id: 1,
        time: "1.0000",
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        proto: PROTO_SOMEIP,
        dir: "rx",
      }),
      row({
        id: 2,
        time: "1.1000",
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        proto: PROTO_SOMEIP,
        dir: "tx", // newest for this key — fails Rx filter
      }),
      row({
        id: 3,
        time: "1.2000",
        protocol: "gPTP",
        source: "b",
        key: "2:1:0",
        proto: PROTO_GPTP,
        dir: "rx",
        serviceMethod: "--",
        name: "Sync · b",
        sv: 0,
        m: 0,
      }),
    ];
    const f: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["rx"]) };
    const fixed = projectDisplayRows(rows, "fixed", new Set(), 200_000, f);
    expect(fixed.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(fixed.find((r) => r.key === "0:4353:32769")?.id).toBe(1);
  });

  it("Sequential window holds N matching rows (backward scan)", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({
        id: i + 1,
        protocol: i % 2 === 0 ? "gPTP" : "SOME/IP",
        source: "a",
        key: i % 2 === 0 ? `2:${i}:0` : `0:4353:32769`,
        proto: i % 2 === 0 ? PROTO_GPTP : PROTO_SOMEIP,
      }),
    );
    // ids 1..10; even i (0,2,4,6,8) → gPTP ids 1,3,5,7,9; odd → SOME/IP
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_GPTP]),
    };
    const seq = projectDisplayRows(rows, "sequential", new Set(), 3, f);
    expect(seq.map((r) => r.id)).toEqual([5, 7, 9]);
  });

  it("backward scan equals the naive applyFilter + slice result", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({
        id: i + 1,
        protocol: i % 3 === 0 ? "gPTP" : "SOME/IP",
        source: "a",
        key: `k:${i}`,
        proto: i % 3 === 0 ? PROTO_GPTP : PROTO_SOMEIP,
        dir: i % 2 === 0 ? "rx" : "tx",
      }),
    );
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_SOMEIP]),
      dirs: new Set(["rx"]),
    };
    const window = 5;
    const naive = applyFilter(rows, f).slice(-window);
    const optimized = windowSequentialFiltered(rows, window, f);
    expect(optimized.map((r) => r.id)).toEqual(naive.map((r) => r.id));
    expect(
      projectDisplayRows(rows, "sequential", new Set(), window, f).map((r) => r.id),
    ).toEqual(naive.map((r) => r.id));
  });

  it("pinned keys do not bypass filters", () => {
    const rows = [
      row({
        id: 1,
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        proto: PROTO_SOMEIP,
      }),
      row({
        id: 2,
        protocol: "gPTP",
        source: "b",
        key: "2:9:0",
        proto: PROTO_GPTP,
        serviceMethod: "--",
        name: "Sync · b",
        sv: 0,
        m: 0,
      }),
    ];
    const pinned = new Set(["2:9:0"]);
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_SOMEIP]),
    };
    const fixed = projectDisplayRows(rows, "fixed", pinned, 200_000, f);
    expect(fixed.map((r) => r.id)).toEqual([1]);
    expect(fixed.every((r) => r.proto === PROTO_SOMEIP)).toBe(true);
  });

  it("unfiltered Sequential keeps identity when the ring fits the window", () => {
    const rows = [
      row({ id: 1, protocol: "SOME/IP", source: "a", key: "0:4353:32769" }),
      row({ id: 2, protocol: "SOME/IP", source: "a", key: "0:4353:32769" }),
    ];
    expect(projectDisplayRows(rows, "sequential", new Set(), 200_000, EMPTY_FILTER)).toBe(
      rows,
    );
  });
});

describe("projectDisplayRows filter perf guardrail (v0.1.7)", () => {
  const RING = 200_000;
  const WINDOW = 10_000;

  function buildRing(n: number): TraceFrame[] {
    // Every 10th row is gPTP (match); the rest SOME/IP (miss) — dense enough
    // that a full-ring scan would visit 200k, but the tail fills WINDOW early.
    const rows: TraceFrame[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const gptp = i % 10 === 0;
      rows[i] = row({
        id: i + 1,
        protocol: gptp ? "gPTP" : "SOME/IP",
        source: "a",
        key: gptp ? `2:${i}:0` : `0:4353:${i}`,
        proto: gptp ? PROTO_GPTP : PROTO_SOMEIP,
      });
    }
    return rows;
  }

  it("Sequential with Protocol filter visits at most window + non-matches in the scanned tail", () => {
    const rows = buildRing(RING);
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_GPTP]),
    };
    let visits = 0;
    let nonMatches = 0;
    const out = projectDisplayRows(rows, "sequential", new Set(), WINDOW, f, {
      onVisit: (r) => {
        visits += 1;
        if (r.proto !== PROTO_GPTP) nonMatches += 1;
      },
    });
    expect(out).toHaveLength(WINDOW);
    // Algorithmic bound: stop once WINDOW matches are collected.
    expect(visits).toBeLessThanOrEqual(WINDOW + nonMatches);
    expect(visits).toBe(WINDOW + nonMatches);
    // Must not scan the whole 200k ring when the tail already fills the window.
    expect(visits).toBeLessThan(RING);
    // 1-in-10 match density → ~10× WINDOW visits to collect WINDOW matches.
    expect(visits).toBe(WINDOW * 10);
  });

  it("unfiltered path returns the same array reference on a full-size ring", () => {
    const rows = buildRing(RING);
    expect(projectDisplayRows(rows, "sequential", new Set(), RING, EMPTY_FILTER)).toBe(
      rows,
    );
  });

  it("measures Fixed and Sequential filtered cost on 200k rows (reported, not asserted)", () => {
    const rows = buildRing(RING);
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_GPTP]),
    };
    const t0 = performance.now();
    const fixed = projectDisplayRows(rows, "fixed", new Set(), RING, f);
    const fixedMs = performance.now() - t0;
    const t1 = performance.now();
    const seq = projectDisplayRows(rows, "sequential", new Set(), WINDOW, f);
    const seqMs = performance.now() - t1;
    // Sanity: both paths produce matching rows; timings go to the final report.
    expect(fixed.length).toBeGreaterThan(0);
    expect(seq).toHaveLength(WINDOW);
    console.log(
      `[filter-perf] 200k rows: Fixed=${fixedMs.toFixed(1)}ms Sequential(window=${WINDOW})=${seqMs.toFixed(1)}ms fixedRows=${fixed.length}`,
    );
  });
});

describe("serviceMethodId / nameFilterId", () => {
  it("formats sv:m as decimal id pair", () => {
    expect(
      serviceMethodId(
        row({ id: 1, protocol: "SOME/IP", source: "a", key: "k", sv: 0x1103, m: 0x8001 }),
      ),
    ).toBe("4355:32769");
  });

  it("keys DoIP Name filters by doip:ty (Service stays sv:m)", () => {
    const announce = row({
      id: 1,
      protocol: "DoIP",
      source: "fusion",
      key: "10:1:4",
      proto: PROTO_DOIP,
      ty: DOIP_TY_VEHICLE_ANNOUNCE,
      sv: 0x1000,
      m: 0,
      name: "Vehicle Announcement",
      serviceMethod: "--",
    });
    const diag = row({
      id: 2,
      protocol: "DoIP",
      source: "tester",
      key: "10:3712>4096:62",
      proto: PROTO_DOIP,
      ty: DOIP_TY_DIAG,
      sv: 0x0e80,
      m: 0x1000,
      name: "Diagnostic Message",
      type: "TesterPresent",
      serviceMethod: "0x0E80 → 0x1000",
    });
    expect(nameFilterId(announce)).toBe(`doip:${DOIP_TY_VEHICLE_ANNOUNCE}`);
    expect(nameFilterId(diag)).toBe(`doip:${DOIP_TY_DIAG}`);
    expect(serviceMethodId(diag)).toBe(`${0x0e80}:${0x1000}`);

    const names = distinctValues([announce, diag, announce], "name");
    expect(names.map((o) => o.key).sort()).toEqual(
      [`doip:${DOIP_TY_DIAG}`, `doip:${DOIP_TY_VEHICLE_ANNOUNCE}`].sort(),
    );
    expect(names.find((o) => o.key === `doip:${DOIP_TY_VEHICLE_ANNOUNCE}`)).toEqual({
      key: `doip:${DOIP_TY_VEHICLE_ANNOUNCE}`,
      label: "Vehicle Announcement",
      count: 2,
    });

    const nameFilter: TraceFilter = {
      ...EMPTY_FILTER,
      names: new Set([`doip:${DOIP_TY_VEHICLE_ANNOUNCE}`]),
    };
    expect(matches(announce, nameFilter)).toBe(true);
    expect(matches(diag, nameFilter)).toBe(false);
  });

  it("keys §7 Name filters by p:ty (plus :se for DNS/HTTP/TLS)", () => {
    const ra = row({
      id: 10,
      protocol: "ICMPv6",
      source: "router",
      key: "12:1:134",
      proto: PROTO_ICMPV6,
      ty: 134,
      se: 0,
      name: "Router Advertisement",
      serviceMethod: "--",
      sv: 0,
      m: 0,
    });
    const dnsA = row({
      id: 11,
      protocol: "DNS",
      source: "host",
      key: "15:1:53>2:53",
      proto: PROTO_DNS,
      ty: DNS_TY_QUERY,
      se: 1,
      name: "DNS query · A",
      serviceMethod: "53:53",
      sv: 53,
      m: 53,
    });
    const dnsPtr = row({
      id: 12,
      protocol: "DNS",
      source: "host",
      key: "15:1:53>2:53",
      proto: PROTO_DNS,
      ty: DNS_TY_QUERY,
      se: 12,
      name: "DNS query · PTR",
      serviceMethod: "53:53",
      sv: 53,
      m: 53,
    });
    const httpGet = row({
      id: 13,
      protocol: "HTTP",
      source: "host",
      key: "23:1:1>2:80",
      proto: PROTO_HTTP,
      ty: HTTP_TY_REQUEST,
      se: 1,
      name: "HTTP GET",
      serviceMethod: "51234:80",
      sv: 51234,
      m: 80,
    });
    const tlsHello = row({
      id: 14,
      protocol: "TLS",
      source: "host",
      key: "24:1:1>2:443",
      proto: PROTO_TLS,
      ty: 22,
      se: 1,
      name: "TLS ClientHello",
      serviceMethod: "51234:443",
      sv: 51234,
      m: 443,
    });
    const lldp = row({
      id: 15,
      protocol: "LLDP",
      source: "switch",
      key: `19:1`,
      proto: PROTO_LLDP,
      ty: 0,
      se: -1,
      name: "LLDP",
      serviceMethod: "--",
      sv: 0,
      m: 0,
    });

    expect(nameFilterId(ra)).toBe(`${PROTO_ICMPV6}:134`);
    expect(nameFilterId(dnsA)).toBe(`${PROTO_DNS}:${DNS_TY_QUERY}:1`);
    expect(nameFilterId(dnsPtr)).toBe(`${PROTO_DNS}:${DNS_TY_QUERY}:12`);
    expect(nameFilterId(httpGet)).toBe(`${PROTO_HTTP}:${HTTP_TY_REQUEST}:1`);
    expect(nameFilterId(tlsHello)).toBe(`${PROTO_TLS}:22:1`);
    expect(nameFilterId(lldp)).toBe(`${PROTO_LLDP}:0`);

    const names = distinctValues([dnsA, dnsPtr, dnsA, tlsHello], "name");
    expect(names.map((o) => o.key).sort()).toEqual(
      [
        `${PROTO_DNS}:${DNS_TY_QUERY}:1`,
        `${PROTO_DNS}:${DNS_TY_QUERY}:12`,
        `${PROTO_TLS}:22:1`,
      ].sort(),
    );
    expect(names.find((o) => o.key === `${PROTO_DNS}:${DNS_TY_QUERY}:1`)?.label).toBe(
      "DNS query · A",
    );
    expect(names.find((o) => o.key === `${PROTO_TLS}:22:1`)?.label).toBe("TLS ClientHello");
  });
});
