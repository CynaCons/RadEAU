import { afterEach, describe, expect, it } from "vitest";

import {
  ENDPOINTS,
  frameKey,
  getSessionEndpoints,
  ipv4String,
  macString,
  projectRow,
  resolveEndpoint,
  resolveSomeIpName,
  setCatalogNames,
  setSessionEndpoints,
  udsTypeLabel,
  type FrameBatchRaw,
} from "./frameModel";
import {
  ARP_TY_REPLY,
  ARP_TY_REQUEST,
  DIR_RX,
  DIR_TX,
  DIR_UNKNOWN,
  DOIP_TY_DIAG,
  DOIP_TY_VEHICLE_ANNOUNCE,
  ENDPOINT_OVERFLOW,
  GPTP_TY_ANNOUNCE,
  GPTP_TY_SYNC,
  PROTO_ARP,
  PROTO_DOIP,
  PROTO_GPTP,
  PROTO_ICMP,
  PROTO_IPV4_OTHER,
  PROTO_IPV6,
  PROTO_MALFORMED,
  PROTO_OTHER,
  PROTO_SD,
  PROTO_SOMEIP,
  PROTO_TCP,
  PROTO_UDP,
  SD_TY_FIND,
  SD_TY_OFFER,
  SOMEIP_TY_NOTIFICATION,
  SOMEIP_TY_REQUEST,
} from "./wireCodes";

function baseBatch(overrides: Partial<FrameBatchRaw> & Pick<FrameBatchRaw, "p">): FrameBatchRaw {
  const n = overrides.p.length;
  const fill = <T,>(v: T): T[] => Array.from({ length: n }, () => v);
  return {
    seq: 0,
    i: fill(1),
    t: fill(0.5),
    d: fill(DIR_RX),
    s: fill(0),
    sv: fill(0),
    m: fill(0),
    ty: fill(0),
    se: fill(-1),
    l: fill(100),
    pb: fill([0xde, 0xad]),
    sa: fill(0),
    da: fill(0),
    sm: fill(0),
    vl: fill(-1),
    po: fill(42),
    ...overrides,
  };
}

function oneRowBatch(s: number): FrameBatchRaw {
  return baseBatch({
    s: [s],
    p: [PROTO_SOMEIP],
    sv: [0x1101],
    m: [0x8001],
    ty: [SOMEIP_TY_NOTIFICATION],
    se: [1],
    sa: [(10 << 24) | (42 << 16) | (0 << 8) | 11],
    da: [(10 << 24) | (42 << 16) | (0 << 8) | 20],
    sm: [0x02004200000b],
    po: [42],
  });
}

describe("ipv4String / macString", () => {
  it("formats network-order IPv4", () => {
    expect(ipv4String((10 << 24) | (42 << 16) | (0 << 8) | 11)).toBe("10.42.0.11");
    expect(ipv4String(0)).toBe("0.0.0.0");
    expect(ipv4String(0xffffffff)).toBe("255.255.255.255");
  });

  it("formats a 48-bit MAC with floor division (no 32-bit bitops)", () => {
    expect(macString(0x02004200000b)).toBe("02:00:42:00:00:0b");
    expect(macString(0xffffffffffff)).toBe("ff:ff:ff:ff:ff:ff");
    expect(macString(0)).toBe("00:00:00:00:00:00");
  });
});

describe("endpoint resolution", () => {
  afterEach(() => {
    setSessionEndpoints(null);
  });

  it("falls back to the static ENDPOINTS table", () => {
    expect(getSessionEndpoints()).toBeNull();
    expect(resolveEndpoint(0)).toEqual({ label: ENDPOINTS[0], title: ENDPOINTS[0] });
    expect(resolveEndpoint(4)).toEqual({ label: ENDPOINTS[4], title: ENDPOINTS[4] });
    expect(resolveEndpoint(99)).toEqual({ label: "ep-99", title: "ep-99" });
  });

  it("prefers session port names with IP tooltips", () => {
    setSessionEndpoints([
      { name: "camera", ip: "10.42.0.11" },
      { name: "radar", ip: "10.42.0.12" },
      { name: "fusion", ip: "10.42.0.20" },
    ]);
    expect(resolveEndpoint(0)).toEqual({
      label: "camera",
      title: "camera (10.42.0.11)",
    });
    expect(resolveEndpoint(2)).toEqual({
      label: "fusion",
      title: "fusion (10.42.0.20)",
    });
  });

  it("uses the IP when session name equals ip (devgen-shaped session)", () => {
    setSessionEndpoints([{ name: "10.42.0.11", ip: "10.42.0.11" }]);
    expect(resolveEndpoint(0)).toEqual({ label: "10.42.0.11", title: "10.42.0.11" });
  });

  it("renders MAC-only session entries by name", () => {
    setSessionEndpoints([{ name: "aa:bb:cc:dd:ee:ff", ip: "" }]);
    expect(resolveEndpoint(0)).toEqual({
      label: "aa:bb:cc:dd:ee:ff",
      title: "aa:bb:cc:dd:ee:ff",
    });
  });

  it("renders the overflow sentinel as other / endpoint table full", () => {
    expect(resolveEndpoint(ENDPOINT_OVERFLOW)).toEqual({
      label: "other",
      title: "endpoint table full",
    });
  });

  it("projects the resolved label into TraceFrame.source / sourceTitle", () => {
    setSessionEndpoints([{ name: "camera", ip: "10.42.0.11" }]);
    const row = projectRow(oneRowBatch(0), 0, null, new Map());
    expect(row.source).toBe("camera");
    expect(row.sourceTitle).toBe("camera (10.42.0.11)");
  });
});

describe("catalog-first SOME/IP names", () => {
  afterEach(() => {
    setCatalogNames(null);
  });

  it("falls back to the static SERVICES table when unloaded", () => {
    expect(resolveSomeIpName(0x1101, 0x8001)).toBe("CameraObjects.ObjectList");
    expect(resolveSomeIpName(0x1201, 0x8001)).toBe("FusedObjects.FusedObjectList");
    expect(resolveSomeIpName(0x9999, 0x8001)).toBe("Service 0x9999");
  });

  it("prefers catalog names when loaded", () => {
    setCatalogNames(
      new Map([
        ["4353:32769", { serviceName: "CameraObjects", eventName: "ObjectList" }],
        ["4609:32770", { serviceName: "FusedObjects", eventName: "FusionStats" }],
        ["4609:32769", { serviceName: "FusedObjects", eventName: "FusedTrackList" }],
        ["4609:1", { serviceName: "FusedObjects", eventName: "SetFusionMode" }],
      ]),
    );
    expect(resolveSomeIpName(0x1101, 0x8001)).toBe("CameraObjects.ObjectList");
    expect(resolveSomeIpName(0x1201, 0x8002)).toBe("FusedObjects.FusionStats");
    expect(resolveSomeIpName(0x1201, 0x8001)).toBe("FusedObjects.FusedTrackList");
    expect(resolveSomeIpName(0x1201, 1)).toBe("FusedObjects.SetFusionMode");
  });

  it("stays honest for unknown ids while the catalog is loaded", () => {
    setCatalogNames(
      new Map([["4353:32769", { serviceName: "CameraObjects", eventName: "ObjectList" }]]),
    );
    expect(resolveSomeIpName(0x1201, 0x8001)).toBe("Service 0x1201");
    expect(resolveSomeIpName(0x9999, 0x1)).toBe("Service 0x9999");
  });

  it("projects catalog names into TraceFrame.name", () => {
    setCatalogNames(
      new Map([
        ["4353:32769", { serviceName: "CameraObjects", eventName: "ObjectList" }],
      ]),
    );
    const row = projectRow(oneRowBatch(0), 0, null, new Map());
    expect(row.name).toBe("CameraObjects.ObjectList");
  });
});

describe("projectRow per class", () => {
  afterEach(() => {
    setSessionEndpoints(null);
    setCatalogNames(null);
  });

  const sa = (10 << 24) | (42 << 16) | (0 << 8) | 11;
  const da = (10 << 24) | (42 << 16) | (0 << 8) | 20;
  const sm = 0x02004200000b;

  it("projects SOME/IP with catalog name and Notification type", () => {
    const batch = baseBatch({
      p: [PROTO_SOMEIP],
      sv: [0x1101],
      m: [0x8001],
      ty: [SOMEIP_TY_NOTIFICATION],
      se: [3],
      sa: [sa],
      da: [da],
      sm: [sm],
      po: [42],
      l: [100],
    });
    const row = projectRow(batch, 0, null, new Map());
    expect(row.protocol).toBe("SOME/IP");
    expect(row.serviceMethod).toBe("0x1101:0x8001");
    expect(row.name).toBe("CameraObjects.ObjectList");
    expect(row.type).toBe("Notification");
    expect(row.dir).toBe("rx");
    expect(row.key).toBe("0:4353:32769");
  });

  it("projects SOME/IP Request type", () => {
    const batch = baseBatch({
      p: [PROTO_SOMEIP],
      sv: [0x1201],
      m: [1],
      ty: [SOMEIP_TY_REQUEST],
      sa: [sa],
      da: [da],
      sm: [sm],
    });
    expect(projectRow(batch, 0, null, new Map()).type).toBe("Request");
  });

  it("projects SD Offer as kind · source", () => {
    setSessionEndpoints([{ name: "camera", ip: "10.42.0.11" }]);
    const batch = baseBatch({
      p: [PROTO_SD],
      sv: [0xffff],
      m: [0x8100],
      ty: [SD_TY_OFFER],
      s: [0],
      sa: [sa],
      sm: [sm],
    });
    const row = projectRow(batch, 0, null, new Map());
    expect(row.protocol).toBe("SD");
    expect(row.type).toBe("Offer");
    expect(row.name).toBe("Offer · camera");
    expect(row.serviceMethod).toBe("0xFFFF:0x8100");
  });

  it("projects SD Find", () => {
    const batch = baseBatch({
      p: [PROTO_SD],
      sv: [0xffff],
      m: [0x8100],
      ty: [SD_TY_FIND],
      sa: [sa],
      sm: [sm],
    });
    const row = projectRow(batch, 0, null, new Map());
    expect(row.type).toBe("Find");
    expect(row.name.startsWith("Find ·")).toBe(true);
  });

  it("projects gPTP Sync · source", () => {
    const batch = baseBatch({
      p: [PROTO_GPTP],
      ty: [GPTP_TY_SYNC],
      sa: [0],
      da: [0],
      sm: [sm],
      po: [14],
      l: [44],
    });
    const row = projectRow(batch, 0, null, new Map());
    expect(row.protocol).toBe("gPTP");
    expect(row.type).toBe("Sync");
    expect(row.name).toBe(`Sync · ${ENDPOINTS[0]}`);
    expect(row.serviceMethod).toBe("--");
  });

  it("projects gPTP Announce", () => {
    const batch = baseBatch({
      p: [PROTO_GPTP],
      ty: [GPTP_TY_ANNOUNCE],
      sm: [sm],
      po: [14],
    });
    expect(projectRow(batch, 0, null, new Map()).type).toBe("Announce");
  });

  it("projects ARP who-has / is-at", () => {
    const req = baseBatch({
      p: [PROTO_ARP],
      ty: [ARP_TY_REQUEST],
      sa: [sa],
      da: [da],
      sm: [sm],
      po: [14],
    });
    expect(projectRow(req, 0, null, new Map()).name).toBe("who-has 10.42.0.20");
    expect(projectRow(req, 0, null, new Map()).type).toBe("Request");

    const reply = baseBatch({
      p: [PROTO_ARP],
      ty: [ARP_TY_REPLY],
      sa: [sa],
      da: [da],
      sm: [sm],
      po: [14],
    });
    expect(projectRow(reply, 0, null, new Map()).name).toBe("10.42.0.11 is-at");
    expect(projectRow(reply, 0, null, new Map()).type).toBe("Reply");
  });

  it("projects UDP/TCP flow names and port Service:Method", () => {
    const udp = baseBatch({
      p: [PROTO_UDP],
      sv: [30501],
      m: [30490],
      sa: [sa],
      da: [da],
      sm: [sm],
    });
    const row = projectRow(udp, 0, null, new Map());
    expect(row.protocol).toBe("UDP");
    expect(row.name).toBe("10.42.0.11:30501 → 10.42.0.20:30490");
    expect(row.serviceMethod).toBe("30501:30490");

    const tcp = baseBatch({
      p: [PROTO_TCP],
      sv: [443],
      m: [51234],
      sa: [sa],
      da: [da],
      sm: [sm],
    });
    expect(projectRow(tcp, 0, null, new Map()).protocol).toBe("TCP");
    expect(projectRow(tcp, 0, null, new Map()).serviceMethod).toBe("443:51234");
  });

  it("projects ICMP / IPv6 / IPv4 / Other / Malformed names", () => {
    expect(
      projectRow(
        baseBatch({ p: [PROTO_ICMP], sv: [8], m: [0], sa: [sa], da: [da], sm: [sm] }),
        0,
        null,
        new Map(),
      ).name,
    ).toBe("type 8 code 0");
    expect(
      projectRow(baseBatch({ p: [PROTO_IPV6], sv: [58], sm: [sm] }), 0, null, new Map()).name,
    ).toBe("next header 58");
    expect(
      projectRow(baseBatch({ p: [PROTO_IPV4_OTHER], sv: [47], sm: [sm] }), 0, null, new Map()).name,
    ).toBe("protocol 47");
    expect(
      projectRow(baseBatch({ p: [PROTO_OTHER], sv: [0x88b5], sm: [sm] }), 0, null, new Map()).name,
    ).toBe("EtherType 0x88B5");
    expect(
      projectRow(
        baseBatch({ p: [PROTO_MALFORMED], l: [8], sm: [sm], po: [0] }),
        0,
        null,
        new Map(),
      ).name,
    ).toBe("runt · 8 bytes");
    expect(
      projectRow(baseBatch({ p: [PROTO_MALFORMED], l: [8], sm: [sm], po: [0] }), 0, null, new Map())
        .protocol,
    ).toBe("Malformed");
  });

  it("renders Unknown (n) for an unlisted class code", () => {
    const row = projectRow(baseBatch({ p: [99] }), 0, null, new Map());
    expect(row.protocol).toBe("Unknown (99)");
  });

  it("maps DIR_* to rx / tx / unknown", () => {
    expect(projectRow(baseBatch({ p: [PROTO_SOMEIP], d: [DIR_RX] }), 0, null, new Map()).dir).toBe(
      "rx",
    );
    expect(projectRow(baseBatch({ p: [PROTO_SOMEIP], d: [DIR_TX] }), 0, null, new Map()).dir).toBe(
      "tx",
    );
    expect(
      projectRow(baseBatch({ p: [PROTO_SOMEIP], d: [DIR_UNKNOWN] }), 0, null, new Map()).dir,
    ).toBe("unknown");
  });

  it("uses po for payload preview length", () => {
    const pb = [0xaa, 0xbb, 0xcc, 0xdd];
    const withPo = baseBatch({
      p: [PROTO_SOMEIP],
      l: [50],
      po: [48],
      pb: [pb],
      sa: [sa],
      sm: [sm],
    });
    // payloadLen = 50 - 48 = 2 → first two bytes
    expect(projectRow(withPo, 0, null, new Map()).payload).toBe("AA BB");

    const gptp = baseBatch({
      p: [PROTO_GPTP],
      l: [44],
      po: [14],
      pb: [pb],
      sm: [sm],
    });
    // payloadLen = 30 > 4 → ellipsis
    expect(projectRow(gptp, 0, null, new Map()).payload).toBe("AA BB CC DD …");
  });

  it("projects DoIP Vehicle Announcement (discovery)", () => {
    const batch = baseBatch({
      p: [PROTO_DOIP],
      ty: [DOIP_TY_VEHICLE_ANNOUNCE],
      sv: [0x1000],
      m: [0],
      se: [-1],
      sa: [sa],
      da: [da],
      sm: [sm],
    });
    const row = projectRow(batch, 0, null, new Map());
    expect(row.protocol).toBe("DoIP");
    expect(row.name).toBe("Vehicle Announcement");
    expect(row.type).toBe("--");
    expect(row.serviceMethod).toBe("--");
    expect(row.session).toBe("--");
    expect(row.key).toBe(`10:${sa}:${DOIP_TY_VEHICLE_ANNOUNCE}`);
  });

  it("projects DoIP TesterPresent request / response / NRC", () => {
    const tester = 0x0e80;
    const gateway = 0x1000;
    const req = baseBatch({
      p: [PROTO_DOIP],
      ty: [DOIP_TY_DIAG],
      sv: [tester],
      m: [gateway],
      se: [0x3e],
      sa: [sa],
      da: [da],
      sm: [sm],
    });
    const reqRow = projectRow(req, 0, null, new Map());
    expect(reqRow.name).toBe("Diagnostic Message");
    expect(reqRow.type).toBe("TesterPresent");
    expect(reqRow.serviceMethod).toBe("0x0E80 → 0x1000");
    expect(reqRow.session).toBe("--");

    const res = baseBatch({
      p: [PROTO_DOIP],
      ty: [DOIP_TY_DIAG],
      sv: [gateway],
      m: [tester],
      se: [0x7e],
      sa: [da],
      da: [sa],
      sm: [sm],
    });
    const resRow = projectRow(res, 0, null, new Map());
    expect(resRow.type).toBe("TesterPresent response");

    const nrc = baseBatch({
      p: [PROTO_DOIP],
      ty: [DOIP_TY_DIAG],
      sv: [gateway],
      m: [tester],
      se: [0x7f],
      sa: [da],
      da: [sa],
      sm: [sm],
    });
    expect(projectRow(nrc, 0, null, new Map()).type).toBe("NRC");
  });
});

describe("udsTypeLabel", () => {
  it("maps absent / named / response / NRC / unknown SIDs", () => {
    expect(udsTypeLabel(-1)).toBe("--");
    expect(udsTypeLabel(0x3e)).toBe("TesterPresent");
    expect(udsTypeLabel(0x7e)).toBe("TesterPresent response");
    expect(udsTypeLabel(0x7f)).toBe("NRC");
    expect(udsTypeLabel(0x22)).toBe("ReadDataByIdentifier");
    expect(udsTypeLabel(0x62)).toBe("ReadDataByIdentifier response");
    expect(udsTypeLabel(0xab)).toBe("SID 0xAB");
  });
});

describe("frameKey", () => {
  const sa = (10 << 24) | (42 << 16) | (0 << 8) | 11;
  const da = (10 << 24) | (42 << 16) | (0 << 8) | 20;
  const sm = 0x02004200000b;

  it("keys SOME/IP by protocol + service + method", () => {
    const batch = baseBatch({
      p: [PROTO_SOMEIP],
      sv: [0x1101],
      m: [0x8001],
      sa: [sa],
      sm: [sm],
    });
    expect(frameKey(batch, 0)).toBe("0:4353:32769");
  });

  it("keys SD by srcAddrKey (sa when non-zero else sm)", () => {
    expect(
      frameKey(baseBatch({ p: [PROTO_SD], sa: [sa], sm: [sm], ty: [SD_TY_OFFER] }), 0),
    ).toBe(`1:${sa}`);
    expect(
      frameKey(baseBatch({ p: [PROTO_SD], sa: [0], sm: [sm], ty: [SD_TY_OFFER] }), 0),
    ).toBe(`1:${sm}`);
  });

  it("keys gPTP by srcAddrKey + ty", () => {
    expect(
      frameKey(baseBatch({ p: [PROTO_GPTP], sa: [0], sm: [sm], ty: [GPTP_TY_SYNC] }), 0),
    ).toBe(`2:${sm}:0`);
    expect(
      frameKey(baseBatch({ p: [PROTO_GPTP], sa: [0], sm: [sm], ty: [GPTP_TY_ANNOUNCE] }), 0),
    ).toBe(`2:${sm}:5`);
  });

  it("keys ARP / UDP / TCP / ICMP / L3 / Malformed per §5.2", () => {
    expect(frameKey(baseBatch({ p: [PROTO_ARP], sa: [sa], sm: [sm] }), 0)).toBe(`3:${sa}`);
    expect(
      frameKey(
        baseBatch({ p: [PROTO_UDP], sa: [sa], da: [da], sv: [1], m: [2], sm: [sm] }),
        0,
      ),
    ).toBe(`4:${sa}:1>${da}:2`);
    expect(
      frameKey(
        baseBatch({ p: [PROTO_TCP], sa: [sa], da: [da], sv: [3], m: [4], sm: [sm] }),
        0,
      ),
    ).toBe(`5:${sa}:3>${da}:4`);
    expect(frameKey(baseBatch({ p: [PROTO_ICMP], sa: [sa], da: [da], sm: [sm] }), 0)).toBe(
      `6:${sa}>${da}`,
    );
    expect(frameKey(baseBatch({ p: [PROTO_IPV6], sv: [58], sm: [sm] }), 0)).toBe(`7:${sm}:58`);
    expect(frameKey(baseBatch({ p: [PROTO_IPV4_OTHER], sv: [47], sm: [sm] }), 0)).toBe(
      `8:${sm}:47`,
    );
    expect(frameKey(baseBatch({ p: [PROTO_OTHER], sv: [0x88b5], sm: [sm] }), 0)).toBe(
      `9:${sm}:${0x88b5}`,
    );
    expect(frameKey(baseBatch({ p: [PROTO_MALFORMED], sm: [sm] }), 0)).toBe(`11:${sm}`);
  });

  it("keys DoIP discovery by srcAddrKey + ty; diagnostics fold response bit", () => {
    expect(
      frameKey(
        baseBatch({
          p: [PROTO_DOIP],
          ty: [DOIP_TY_VEHICLE_ANNOUNCE],
          sa: [sa],
          sm: [sm],
        }),
        0,
      ),
    ).toBe(`10:${sa}:${DOIP_TY_VEHICLE_ANNOUNCE}`);

    const tester = 0x0e80;
    const gateway = 0x1000;
    const reqKey = frameKey(
      baseBatch({
        p: [PROTO_DOIP],
        ty: [DOIP_TY_DIAG],
        sv: [tester],
        m: [gateway],
        se: [0x3e],
        sa: [sa],
        sm: [sm],
      }),
      0,
    );
    const resKey = frameKey(
      baseBatch({
        p: [PROTO_DOIP],
        ty: [DOIP_TY_DIAG],
        sv: [tester],
        m: [gateway],
        se: [0x7e],
        sa: [da],
        sm: [sm],
      }),
      0,
    );
    expect(reqKey).toBe(`10:${tester}>${gateway}:${0x3e}`);
    expect(resKey).toBe(reqKey);
  });

  it("computes per-node cycle time for SD offers from different sources", () => {
    const lastByKey = new Map<string, number>();
    const batch = (s: number, t: number, idx: number, srcSa: number): FrameBatchRaw =>
      baseBatch({
        i: [idx],
        t: [t],
        s: [s],
        p: [PROTO_SD],
        sv: [0xffff],
        m: [0x8100],
        ty: [SD_TY_OFFER],
        sa: [srcSa],
        sm: [0x020042000000 + s],
        l: [80],
        pb: [[0xaa]],
        po: [42],
      });
    const a0 = projectRow(batch(0, 1.0, 1, sa), 0, null, lastByKey);
    lastByKey.set(a0.key, 1.0);
    const b0 = projectRow(batch(1, 1.1, 2, da), 0, 1.0, lastByKey);
    lastByKey.set(b0.key, 1.1);
    const a1 = projectRow(batch(0, 1.5, 3, sa), 0, 1.1, lastByKey);
    expect(a0.deltaKey).toBe("--");
    expect(b0.deltaKey).toBe("--");
    expect(a1.deltaKey).toBe("0.5000");
    expect(a0.key).not.toBe(b0.key);
  });
});
