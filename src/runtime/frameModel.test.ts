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
  DHCP_TY_V6_OFFSET,
  DIR_RX,
  DIR_TX,
  DIR_UNKNOWN,
  DNS_TY_MDNS_QUERY,
  DNS_TY_QUERY,
  DNS_TY_RESPONSE,
  DOIP_TY_DIAG,
  DOIP_TY_VEHICLE_ANNOUNCE,
  ENDPOINT_OVERFLOW,
  GPTP_TY_ANNOUNCE,
  GPTP_TY_SYNC,
  HTTP_TY_REQUEST,
  HTTP_TY_RESPONSE,
  PROTO_ARP,
  PROTO_AVTP,
  PROTO_DHCP,
  PROTO_DNS,
  PROTO_DOIP,
  PROTO_EAPOL,
  PROTO_GPTP,
  PROTO_HTTP,
  PROTO_ICMP,
  PROTO_ICMPV6,
  PROTO_IGMP,
  PROTO_IPV4_OTHER,
  PROTO_IPV6,
  PROTO_LLDP,
  PROTO_MACSEC,
  PROTO_MALFORMED,
  PROTO_NTP,
  PROTO_OTHER,
  PROTO_PTP,
  PROTO_SCTP,
  PROTO_SD,
  PROTO_SNMP,
  PROTO_SOMEIP,
  PROTO_SSDP,
  PROTO_SSH,
  PROTO_TCP,
  PROTO_TFTP,
  PROTO_TLS,
  PROTO_UDP,
  SD_TY_FIND,
  SD_TY_OFFER,
  SOMEIP_TY_NOTIFICATION,
  SOMEIP_TY_REQUEST,
  SSDP_TY_MSEARCH,
  SSH_TY_BANNER,
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

  it("projects ICMPv6 Router Advertisement with code in Type", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_ICMPV6],
        ty: [134],
        se: [0],
        sa: [0],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.protocol).toBe("ICMPv6");
    expect(row.name).toBe("Router Advertisement");
    expect(row.type).toBe("0");
    expect(row.serviceMethod).toBe("--");
    expect(row.session).toBe("--");
  });

  it("projects IGMP Membership Query", () => {
    const row = projectRow(
      baseBatch({ p: [PROTO_IGMP], ty: [0x11], sa: [sa], sm: [sm] }),
      0,
      null,
      new Map(),
    );
    expect(row.protocol).toBe("IGMP");
    expect(row.name).toBe("Membership Query");
    expect(row.serviceMethod).toBe("--");
  });

  it("projects DHCP Discover and DHCPv6 Solicit", () => {
    const v4 = projectRow(
      baseBatch({
        p: [PROTO_DHCP],
        ty: [1],
        se: [0x1234],
        sv: [68],
        m: [67],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(v4.name).toBe("DHCP Discover");
    expect(v4.serviceMethod).toBe("68:67");
    expect(v4.session).toBe("--");

    const v6 = projectRow(
      baseBatch({
        p: [PROTO_DHCP],
        ty: [DHCP_TY_V6_OFFSET + 1],
        se: [0x55],
        sv: [546],
        m: [547],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(v6.name).toBe("DHCPv6 Solicit");
  });

  it("projects DNS query · A and response · NXDomain", () => {
    const query = projectRow(
      baseBatch({
        p: [PROTO_DNS],
        ty: [DNS_TY_QUERY],
        se: [1],
        sv: [53],
        m: [53],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(query.name).toBe("DNS query · A");
    expect(query.type).toBe("A");
    expect(query.serviceMethod).toBe("53:53");

    const mdns = projectRow(
      baseBatch({
        p: [PROTO_DNS],
        ty: [DNS_TY_MDNS_QUERY],
        se: [12],
        sv: [5353],
        m: [5353],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(mdns.name).toBe("mDNS query · PTR");

    const resp = projectRow(
      baseBatch({
        p: [PROTO_DNS],
        ty: [DNS_TY_RESPONSE],
        se: [3],
        sv: [53],
        m: [53],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(resp.name).toBe("DNS response · NXDomain");
    expect(resp.type).toBe("NXDomain");
  });

  it("projects NTP client · stratum n", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_NTP],
        ty: [3],
        se: [2],
        sv: [123],
        m: [123],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("NTP client · stratum 2");
    expect(row.type).toBe("stratum 2");
    expect(row.serviceMethod).toBe("123:123");
  });

  it("projects SSDP M-SEARCH", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_SSDP],
        ty: [SSDP_TY_MSEARCH],
        sv: [1900],
        m: [1900],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("SSDP M-SEARCH");
    expect(row.type).toBe("M-SEARCH");
  });

  it("projects PTP Sync · domain n with Service:Method --", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_PTP],
        ty: [GPTP_TY_SYNC],
        sv: [0],
        m: [42],
        sa: [sa],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.protocol).toBe("PTP");
    expect(row.name).toBe("PTP Sync · domain 0");
    expect(row.type).toBe("domain 0");
    expect(row.serviceMethod).toBe("--");
  });

  it("projects LLDP", () => {
    const row = projectRow(
      baseBatch({ p: [PROTO_LLDP], ty: [0], sm: [sm] }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("LLDP");
    expect(row.serviceMethod).toBe("--");
  });

  it("projects AVTP AAF subtype", () => {
    const row = projectRow(
      baseBatch({ p: [PROTO_AVTP], ty: [0x02], sm: [sm] }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("AVTP AAF");
    expect(row.type).toBe("AAF");
  });

  it("projects MACsec · AN n", () => {
    const row = projectRow(
      baseBatch({ p: [PROTO_MACSEC], ty: [2], sm: [sm] }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("MACsec · AN 2");
    expect(row.type).toBe("AN 2");
  });

  it("projects EAPOL Key", () => {
    const row = projectRow(
      baseBatch({ p: [PROTO_EAPOL], ty: [3], sm: [sm] }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("EAPOL Key");
  });

  it("projects HTTP GET and HTTP 200", () => {
    const req = projectRow(
      baseBatch({
        p: [PROTO_HTTP],
        ty: [HTTP_TY_REQUEST],
        se: [1],
        sv: [51234],
        m: [80],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(req.name).toBe("HTTP GET");
    expect(req.type).toBe("GET");
    expect(req.serviceMethod).toBe("51234:80");

    const res = projectRow(
      baseBatch({
        p: [PROTO_HTTP],
        ty: [HTTP_TY_RESPONSE],
        se: [200],
        sv: [80],
        m: [51234],
        sa: [da],
        da: [sa],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(res.name).toBe("HTTP 200");
  });

  it("projects TLS ClientHello and Application Data", () => {
    const hello = projectRow(
      baseBatch({
        p: [PROTO_TLS],
        ty: [22],
        se: [1],
        sv: [51234],
        m: [443],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(hello.name).toBe("TLS ClientHello");
    expect(hello.type).toBe("ClientHello");

    const app = projectRow(
      baseBatch({
        p: [PROTO_TLS],
        ty: [23],
        se: [-1],
        sv: [51234],
        m: [443],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(app.name).toBe("TLS Application Data");
  });

  it("projects SSH banner", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_SSH],
        ty: [SSH_TY_BANNER],
        sv: [22],
        m: [51234],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("SSH banner");
  });

  it("projects SCTP INIT", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_SCTP],
        ty: [1],
        sv: [5000],
        m: [5001],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("SCTP INIT");
    expect(row.serviceMethod).toBe("5000:5001");
  });

  it("projects TFTP RRQ", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_TFTP],
        ty: [1],
        sv: [69],
        m: [69],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("TFTP RRQ");
  });

  it("projects SNMP GetRequest", () => {
    const row = projectRow(
      baseBatch({
        p: [PROTO_SNMP],
        ty: [0xa0],
        sv: [161],
        m: [161],
        sa: [sa],
        da: [da],
        sm: [sm],
      }),
      0,
      null,
      new Map(),
    );
    expect(row.name).toBe("SNMP GetRequest");
  });

  it("renders unknown ty/se as numbers without crashing", () => {
    expect(
      projectRow(
        baseBatch({ p: [PROTO_ICMPV6], ty: [200], se: [9], sm: [sm] }),
        0,
        null,
        new Map(),
      ).name,
    ).toBe("Type 200");
    expect(
      projectRow(
        baseBatch({
          p: [PROTO_DNS],
          ty: [DNS_TY_QUERY],
          se: [99],
          sv: [53],
          m: [53],
          sa: [sa],
          da: [da],
          sm: [sm],
        }),
        0,
        null,
        new Map(),
      ).name,
    ).toBe("DNS query · 99");
    expect(
      projectRow(
        baseBatch({ p: [PROTO_AVTP], ty: [0x40], sm: [sm] }),
        0,
        null,
        new Map(),
      ).name,
    ).toBe("AVTP subtype 64");
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
    // The response carries the swapped pair (gateway → tester).
    const resKey = frameKey(
      baseBatch({
        p: [PROTO_DOIP],
        ty: [DOIP_TY_DIAG],
        sv: [gateway],
        m: [tester],
        se: [0x7e],
        sa: [da],
        sm: [sm],
      }),
      0,
    );
    expect(reqKey).toBe(`10:${tester}<>${gateway}:${0x3e}`);
    expect(resKey).toBe(reqKey);
  });

  it("keys §7 classes per Fixed-mode rules", () => {
    expect(
      frameKey(baseBatch({ p: [PROTO_ICMPV6], sa: [sa], sm: [sm], ty: [134] }), 0),
    ).toBe(`12:${sa}:134`);
    expect(
      frameKey(baseBatch({ p: [PROTO_ICMPV6], sa: [0], sm: [sm], ty: [134] }), 0),
    ).toBe(`12:${sm}:134`);
    expect(
      frameKey(baseBatch({ p: [PROTO_IGMP], sa: [sa], sm: [sm], ty: [0x11] }), 0),
    ).toBe(`13:${sa}:17`);
    expect(
      frameKey(
        baseBatch({
          p: [PROTO_DHCP],
          sa: [sa],
          da: [da],
          sv: [68],
          m: [67],
          sm: [sm],
          ty: [1],
        }),
        0,
      ),
    ).toBe(`14:${sa}:68>${da}:67`);
    expect(
      frameKey(
        baseBatch({
          p: [PROTO_DNS],
          sa: [sa],
          da: [da],
          sv: [53],
          m: [53],
          sm: [sm],
          ty: [DNS_TY_QUERY],
        }),
        0,
      ),
    ).toBe(`15:${sa}:53>${da}:53`);
    expect(
      frameKey(
        baseBatch({
          p: [PROTO_HTTP],
          sa: [sa],
          da: [da],
          sv: [1],
          m: [80],
          sm: [sm],
        }),
        0,
      ),
    ).toBe(`23:${sa}:1>${da}:80`);
    expect(
      frameKey(baseBatch({ p: [PROTO_PTP], sa: [sa], sm: [sm], ty: [GPTP_TY_SYNC] }), 0),
    ).toBe(`18:${sa}:0`);
    expect(frameKey(baseBatch({ p: [PROTO_LLDP], sm: [sm], ty: [0] }), 0)).toBe(
      `19:${sm}`,
    );
    expect(frameKey(baseBatch({ p: [PROTO_AVTP], sm: [sm], ty: [2] }), 0)).toBe(
      `20:${sm}:2`,
    );
    expect(frameKey(baseBatch({ p: [PROTO_MACSEC], sm: [sm], ty: [1] }), 0)).toBe(
      `21:${sm}`,
    );
    expect(frameKey(baseBatch({ p: [PROTO_EAPOL], sm: [sm], ty: [3] }), 0)).toBe(
      `22:${sm}`,
    );
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
