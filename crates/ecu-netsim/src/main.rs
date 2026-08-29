//! Minimal wall-clock-paced sensor-fusion simulator for RadEAU's monitor link.
//!
//! Event traffic is deliberately unconditional in this cut: SD subscribe/Ack
//! routing belongs to the later v0.4 runtime. Pseudo-data derives from the
//! supplied seed; monitor clients use bounded, independent writer queues.

use radeau_catalog::{BaseType, Catalog, Signal};
use radeau_proto::{
    arp::{self, ArpPacket},
    ethernet::{EthernetFrame, VlanTag},
    gptp,
    icmp::IcmpPacket,
    ipv4::{self, Ipv4Packet},
    ipv6::Ipv6Packet,
    sd, someip,
    udp::UdpDatagram,
};
use std::{
    io::{self, Write},
    net::{Ipv4Addr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

const QUEUE: usize = 4096;
const HANDSHAKE: &str = "{\"link\":\"ecu-netsim-monitor\",\"version\":1,\"scenario\":\"sensor-fusion\",\"ports\":[{\"id\":1,\"name\":\"camera\",\"ip\":\"10.42.0.11\"},{\"id\":2,\"name\":\"radar\",\"ip\":\"10.42.0.12\"},{\"id\":3,\"name\":\"lidar\",\"ip\":\"10.42.0.13\"},{\"id\":4,\"name\":\"dynamics\",\"ip\":\"10.42.0.14\"},{\"id\":5,\"name\":\"fusion\",\"ip\":\"10.42.0.20\"}]}\n";

#[derive(Clone)]
struct Record {
    time: u64,
    port: u16,
    frame: Vec<u8>,
}
struct Client {
    tx: mpsc::SyncSender<Vec<u8>>,
    dropped: u32,
    first: u64,
}
#[derive(Clone, Copy)]
struct Node {
    port: u16,
    ip: [u8; 4],
    service: u16,
    cycle: u64,
    size: usize,
}
const NODES: [Node; 5] = [
    Node {
        port: 1,
        ip: [10, 42, 0, 11],
        service: 0x1101,
        cycle: 33,
        size: 128,
    },
    Node {
        port: 2,
        ip: [10, 42, 0, 12],
        service: 0x1102,
        cycle: 50,
        size: 96,
    },
    Node {
        port: 3,
        ip: [10, 42, 0, 13],
        service: 0x1103,
        cycle: 100,
        size: 160,
    },
    Node {
        port: 4,
        ip: [10, 42, 0, 14],
        service: 0x1104,
        cycle: 10,
        size: 48,
    },
    Node {
        port: 5,
        ip: [10, 42, 0, 20],
        service: 0x1201,
        cycle: 50,
        size: 144,
    },
];

fn main() {
    let (port, seed) = match args() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2)
        }
    };
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("failed to bind monitor link: {e}");
            std::process::exit(1)
        }
    };
    let actual = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    println!("monitor link listening on 127.0.0.1:{actual}");
    let catalog =
        match radeau_catalog::from_arxml(include_str!("../../../catalog/sensor-fusion.arxml")) {
            Ok((catalog, _)) => catalog,
            Err(error) => {
                eprintln!("catalog load failed: {error}");
                std::process::exit(1)
            }
        };
    run(listener, seed, Arc::new(AtomicBool::new(true)), &catalog);
}

fn args() -> Result<(u16, u64), String> {
    let mut port = 5560;
    let mut seed = 1;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        if flag == "--version" || flag == "-V" {
            println!(
                "ecu-netsim {} (codec: {})",
                env!("CARGO_PKG_VERSION"),
                radeau_proto::CRATE_NAME
            );
            std::process::exit(0)
        }
        let value = it
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--monitor-port" => {
                port = value
                    .parse()
                    .map_err(|_| format!("invalid monitor port: {value}"))?
            }
            "--seed" => {
                seed = value
                    .parse()
                    .map_err(|_| format!("invalid seed: {value}"))?
            }
            _ => {
                return Err(format!(
                    "unknown argument: {flag}; usage: ecu-netsim [--monitor-port 5560] [--seed N]"
                ))
            }
        }
    }
    Ok((port, seed))
}

fn run(listener: TcpListener, seed: u64, running: Arc<AtomicBool>, catalog: &Catalog) {
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    let start = Instant::now();
    let mut clients = Vec::new();
    let mut next = NODES.map(|_| start);
    let mut sd_at = start;
    let mut ptp_at = start;
    let mut fusion_stats_at = start;
    let mut arp_at = start + Duration::from_secs(2);
    let mut router_at = start + Duration::from_secs(5);
    let mut runt_at = start + Duration::from_secs(10);
    let mut arp_node = 0usize;
    let mut sessions = [1u16; 5];
    let mut seq = 1;
    let mut rng = seed;
    let mut ident = 1;
    while running.load(Ordering::Relaxed) {
        accept(&listener, &mut clients);
        let now = Instant::now();
        for (i, node) in NODES.iter().enumerate() {
            if now >= next[i] {
                let session = sessions[i];
                fanout(
                    &mut clients,
                    Record {
                        time: ns(start),
                        port: node.port,
                        frame: event(*node, 0x8001, session, &mut rng, &mut ident, catalog),
                    },
                );
                sessions[i] = next_id(sessions[i]);
                next[i] += Duration::from_millis(node.cycle);
            }
        }
        if now >= fusion_stats_at {
            let session = sessions[4];
            fanout(
                &mut clients,
                Record {
                    time: ns(start),
                    port: 5,
                    frame: event(NODES[4], 0x8002, session, &mut rng, &mut ident, catalog),
                },
            );
            sessions[4] = next_id(sessions[4]);
            fusion_stats_at += Duration::from_secs(1);
        }
        if now >= sd_at {
            for (i, node) in NODES.iter().enumerate() {
                let session = sessions[i];
                fanout(
                    &mut clients,
                    Record {
                        time: ns(start),
                        port: node.port,
                        frame: offer(*node, session, &mut ident),
                    },
                );
                sessions[i] = next_id(sessions[i]);
            }
            sd_at += Duration::from_secs(1);
        }
        if now >= ptp_at {
            for kind in [gptp::MSG_SYNC, gptp::MSG_FOLLOW_UP] {
                fanout(
                    &mut clients,
                    Record {
                        time: ns(start),
                        port: 5,
                        frame: ptp(kind, seq, ns(start)),
                    },
                );
            }
            seq = next_id(seq);
            ptp_at += Duration::from_millis(125);
        }
        if now >= arp_at {
            let asker = NODES[arp_node];
            fanout(
                &mut clients,
                Record {
                    time: ns(start),
                    port: asker.port,
                    frame: arp_frame(asker, NODES[4], false),
                },
            );
            fanout(
                &mut clients,
                Record {
                    time: ns(start),
                    port: 5,
                    frame: arp_frame(NODES[4], asker, true),
                },
            );
            arp_node = (arp_node + 1) % 4;
            arp_at += Duration::from_secs(2);
        }
        if now >= router_at {
            fanout(
                &mut clients,
                Record {
                    time: ns(start),
                    port: 5,
                    frame: router_solicitation(),
                },
            );
            router_at += Duration::from_secs(5);
        }
        if now >= runt_at {
            fanout(
                &mut clients,
                Record {
                    time: ns(start),
                    port: 4,
                    frame: runt_frame(),
                },
            );
            runt_at += Duration::from_secs(10);
        }
        thread::sleep(Duration::from_millis(1));
    }
}

fn accept(listener: &TcpListener, clients: &mut Vec<Client>) {
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // The writer owns every potentially blocking operation.  In
                // particular, a peer that does not read its handshake cannot
                // delay either the virtual switch or other monitor clients.
                let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE);
                if tx.try_send(HANDSHAKE.as_bytes().to_vec()).is_ok() {
                    thread::spawn(move || {
                        while let Ok(bytes) = rx.recv() {
                            if stream.write_all(&bytes).is_err() {
                                break;
                            }
                        }
                    });
                    clients.push(Client {
                        tx,
                        dropped: 0,
                        first: 0,
                    });
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return,
            Err(_) => return,
        }
    }
}
fn fanout(clients: &mut [Client], record: Record) {
    for c in clients {
        if c.dropped != 0 {
            match c
                .tx
                .try_send(gap(c.first, c.dropped, record.time.saturating_sub(c.first)))
            {
                Ok(()) => c.dropped = 0,
                Err(mpsc::TrySendError::Full(_)) => {
                    c.dropped = c.dropped.saturating_add(1);
                    continue;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => continue,
            }
        }
        match c.tx.try_send(record_bytes(&record)) {
            Ok(()) => (),
            Err(mpsc::TrySendError::Full(_)) => {
                if c.dropped == 0 {
                    c.first = record.time;
                }
                c.dropped = c.dropped.saturating_add(1)
            }
            Err(mpsc::TrySendError::Disconnected(_)) => (),
        }
    }
}
fn record_bytes(r: &Record) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(11 + r.frame.len() as u32).to_be_bytes());
    out.extend_from_slice(&r.time.to_be_bytes());
    out.extend_from_slice(&r.port.to_be_bytes());
    out.push(0);
    out.extend_from_slice(&r.frame);
    out
}
fn gap(time: u64, dropped: u32, span: u64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&23u32.to_be_bytes());
    out.extend_from_slice(&time.to_be_bytes());
    out.extend_from_slice(&0xffffu16.to_be_bytes());
    out.push(0xff);
    out.extend_from_slice(&dropped.to_be_bytes());
    out.extend_from_slice(&span.to_be_bytes());
    out
}
fn ns(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u64::MAX as u128) as u64
}
fn next_id(v: u16) -> u16 {
    if v == u16::MAX {
        1
    } else {
        v + 1
    }
}
fn next_noise(state: &mut u64) -> u8 {
    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
    (*state >> 32) as u8
}

/// Encodes only catalog-defined signal bytes; the fixed frame-size tail remains
/// zero. The seed only affects bounded latency jitter, never arbitrary bytes.
fn event(
    node: Node,
    method: u16,
    session: u16,
    rng: &mut u64,
    ident: &mut u16,
    catalog: &Catalog,
) -> Vec<u8> {
    let mut payload = vec![0u8; node.size];
    if let Some(event) = catalog.event(node.service, method) {
        let phase = session as f64 / 20.0;
        for signal in &event.signals {
            let physical = waveform(signal, phase, rng);
            encode_signal(signal, physical, &mut payload);
        }
    }
    let mut message = Vec::new();
    someip::build(
        &someip::SomeIpHeader {
            service_id: node.service,
            method_id: method,
            length: 0,
            client_id: node.port,
            session_id: session,
            protocol_version: 1,
            interface_version: 1,
            message_type: someip::MSG_NOTIFICATION,
            return_code: 0,
        },
        &payload,
        &mut message,
    );
    ip_frame(node, [255; 4], &message, ident)
}

fn waveform(signal: &Signal, phase: f64, rng: &mut u64) -> f64 {
    let sine = phase.sin();
    match signal.name.as_str() {
        n if n.contains("Count") => (8.0 + (phase / 3.0).floor()).rem_euclid(80.0),
        "FrameCounter" => (phase * 20.0).floor().rem_euclid(u16::MAX as f64),
        "PointCount" => 12_000.0 + 2_000.0 * sine,
        "QualityMean" | "MeanIntensity" => 75.0 + 15.0 * sine,
        n if n.contains("Range") => 30.0 + 20.0 * sine,
        n if n.contains("Speed") => {
            if n == "VehicleSpeed" {
                20.0 + 8.0 * sine
            } else {
                -2.0 + 4.0 * sine
            }
        }
        "YawRate" => 0.15 * sine,
        "AccelX" => 1.2 * sine,
        "ExposureTime" => 8.0 + sine,
        "InputLatencyCam" => 20.0 + (next_noise(rng) % 11) as f64 * 0.1,
        "MatchedTracks" => 25.0 + 4.0 * sine,
        "UnmatchedTracks" => 2.0 + (phase.cos() + 1.0),
        _ => 0.0,
    }
}

fn encode_signal(signal: &Signal, physical: f64, payload: &mut [u8]) {
    if signal.factor == 0.0 {
        return;
    }
    let raw = ((physical - signal.offset) / signal.factor).round();
    let end = signal.byte_offset.saturating_add(signal.byte_len);
    let Some(out) = payload.get_mut(signal.byte_offset..end) else {
        return;
    };
    match signal.base {
        BaseType::U8 => out.copy_from_slice(&[(raw.clamp(0.0, u8::MAX as f64)) as u8]),
        BaseType::U16 => {
            out.copy_from_slice(&((raw.clamp(0.0, u16::MAX as f64)) as u16).to_be_bytes())
        }
        BaseType::U32 => {
            out.copy_from_slice(&((raw.clamp(0.0, u32::MAX as f64)) as u32).to_be_bytes())
        }
        BaseType::S16 => out
            .copy_from_slice(&((raw.clamp(i16::MIN as f64, i16::MAX as f64)) as i16).to_be_bytes()),
    }
}
fn offer(node: Node, session: u16, ident: &mut u16) -> Vec<u8> {
    let mut body = Vec::new();
    sd::build(
        &sd::SdMessage {
            flags: 0xc0,
            entries: vec![sd::SdEntry {
                entry_type: sd::ENTRY_OFFER_SERVICE,
                service_id: node.service,
                instance_id: 1,
                major_version: 1,
                ttl: 3,
                minor_version: 0,
            }],
        },
        &mut body,
    );
    let mut message = Vec::new();
    someip::build(
        &someip::SomeIpHeader {
            service_id: someip::SD_SERVICE_ID,
            method_id: someip::SD_METHOD_ID,
            length: 0,
            client_id: node.port,
            session_id: session,
            protocol_version: 1,
            interface_version: 1,
            message_type: someip::MSG_NOTIFICATION,
            return_code: 0,
        },
        &body,
        &mut message,
    );
    ip_frame(node, [224, 244, 224, 245], &message, ident)
}
fn ip_frame(node: Node, dst: [u8; 4], message: &[u8], ident: &mut u16) -> Vec<u8> {
    let mut udp = Vec::new();
    let port = if node.port == 3 && message.get(..2) != Some(&someip::SD_SERVICE_ID.to_be_bytes()) {
        30501
    } else {
        30490
    };
    UdpDatagram::build(node.ip, dst, port, port, message, &mut udp);
    let mut ip = Vec::new();
    Ipv4Packet::build(
        node.ip,
        dst,
        ipv4::PROTOCOL_UDP,
        *ident,
        64,
        0,
        &udp,
        &mut ip,
    );
    *ident = next_id(*ident);
    let mut out = Vec::new();
    let dmac = [1, 0, 0x5e, dst[1] & 0x7f, dst[2], dst[3]];
    let smac = node_mac(node);
    if node.port == 3 {
        EthernetFrame::build_tagged(
            dmac,
            smac,
            VlanTag {
                pcp: 5,
                dei: false,
                vid: 10,
            },
            radeau_proto::ethernet::ETHERTYPE_IPV4,
            &ip,
            &mut out,
        );
    } else {
        EthernetFrame::build(
            dmac,
            smac,
            radeau_proto::ethernet::ETHERTYPE_IPV4,
            &ip,
            &mut out,
        );
    }
    out
}
fn node_mac(node: Node) -> [u8; 6] {
    [2, 0x52, 0x41, 0x44, 0, node.port as u8]
}
fn arp_frame(sender: Node, target: Node, reply: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    ArpPacket::build(
        &ArpPacket {
            hw_type: arp::HTYPE_ETHERNET,
            proto_type: arp::PTYPE_IPV4,
            hw_len: 6,
            proto_len: 4,
            opcode: if reply {
                arp::OPCODE_REPLY
            } else {
                arp::OPCODE_REQUEST
            },
            sender_mac: node_mac(sender),
            sender_ip: sender.ip,
            target_mac: if reply { node_mac(target) } else { [0; 6] },
            target_ip: target.ip,
        },
        &mut payload,
    );
    let dst = if reply { node_mac(target) } else { [0xff; 6] };
    let mut out = Vec::new();
    if sender.port == 3 {
        EthernetFrame::build_tagged(
            dst,
            node_mac(sender),
            VlanTag {
                pcp: 5,
                dei: false,
                vid: 10,
            },
            radeau_proto::ethernet::ETHERTYPE_ARP,
            &payload,
            &mut out,
        )
    } else {
        EthernetFrame::build(
            dst,
            node_mac(sender),
            radeau_proto::ethernet::ETHERTYPE_ARP,
            &payload,
            &mut out,
        )
    }
    out
}
fn router_solicitation() -> Vec<u8> {
    let mac = node_mac(NODES[4]);
    let src = [
        0xfe,
        0x80,
        0,
        0,
        0,
        0,
        0,
        0,
        mac[0] ^ 0x02,
        mac[1],
        mac[2],
        0xff,
        0xfe,
        mac[3],
        mac[4],
        mac[5],
    ];
    let dst = [0xff, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    let mut icmp = Vec::new();
    IcmpPacket::build(133, 0, 0, [0; 4], &[], &mut icmp);
    let sum = icmpv6_checksum(src, dst, &icmp);
    icmp[2..4].copy_from_slice(&sum.to_be_bytes());
    let mut ip = Vec::new();
    Ipv6Packet::build(src, dst, 58, 255, &icmp, &mut ip);
    let mut out = Vec::new();
    EthernetFrame::build(
        [0x33, 0x33, 0, 0, 0, 2],
        mac,
        radeau_proto::ethernet::ETHERTYPE_IPV6,
        &ip,
        &mut out,
    );
    out
}

fn icmpv6_checksum(src: [u8; 16], dst: [u8; 16], message: &[u8]) -> u16 {
    let length = (message.len() as u32).to_be_bytes();
    let next_header = [0, 0, 0, 58];
    radeau_proto::internet_checksum(&[&src, &dst, &length, &next_header, message])
}

fn runt_frame() -> Vec<u8> {
    let mut header = Vec::new();
    EthernetFrame::build(
        node_mac(NODES[4]),
        node_mac(NODES[3]),
        radeau_proto::ethernet::ETHERTYPE_IPV4,
        &[],
        &mut header,
    );
    header.truncate(10);
    header
}
fn ptp(kind: u8, sequence: u16, stamp: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    gptp::build(
        &gptp::GptpMessage {
            msg_type: kind,
            domain: 0,
            sequence_id: sequence,
            correction_ns: 0,
            origin_timestamp_ns: Some(stamp as u128),
        },
        &mut payload,
    );
    let mut out = Vec::new();
    EthernetFrame::build(
        gptp::GPTP_MULTICAST,
        [2, 0x52, 0x41, 0x44, 0, 5],
        gptp::ETHERTYPE_GPTP,
        &payload,
        &mut out,
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read},
        net::TcpStream,
    };
    #[test]
    fn monitor_handshake_and_serialized_records() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let stop = Arc::clone(&running);
        let worker = thread::spawn(move || {
            let catalog =
                radeau_catalog::from_arxml(include_str!("../../../catalog/sensor-fusion.arxml"))
                    .map(|(catalog, _)| catalog)
                    .expect("checked-in extract");
            run(listener, 7, stop, &catalog)
        });
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, HANDSHAKE);
        let mut saw_event = false;
        let mut saw_offer = false;
        let mut saw_sync = false;
        let mut saw_follow_up = false;
        for _ in 0..256 {
            let mut len = [0; 4];
            reader.read_exact(&mut len).unwrap();
            let mut body = vec![0; u32::from_be_bytes(len) as usize];
            reader.read_exact(&mut body).unwrap();
            assert!(body.len() >= 11);
            assert!((1..=5).contains(&u16::from_be_bytes([body[8], body[9]])));
            assert_eq!(body[10], 0);

            let ethernet = EthernetFrame::parse(&body[11..]).unwrap();
            match ethernet.ethertype {
                radeau_proto::ethernet::ETHERTYPE_IPV4 => {
                    let ip = Ipv4Packet::parse(ethernet.payload).unwrap();
                    assert_eq!(ip.protocol, ipv4::PROTOCOL_UDP);
                    assert_eq!(
                        radeau_proto::internet_checksum(&[&ethernet.payload[..20]]),
                        0
                    );
                    let pseudo = [
                        ip.src[0],
                        ip.src[1],
                        ip.src[2],
                        ip.src[3],
                        ip.dst[0],
                        ip.dst[1],
                        ip.dst[2],
                        ip.dst[3],
                        0,
                        ipv4::PROTOCOL_UDP,
                        ip.payload[4],
                        ip.payload[5],
                    ];
                    assert_eq!(radeau_proto::internet_checksum(&[&pseudo, ip.payload]), 0);
                    let udp = UdpDatagram::parse(ip.payload).unwrap();
                    let (someip, payload) = someip::parse(udp.payload).unwrap();
                    if someip.service_id == someip::SD_SERVICE_ID {
                        assert_eq!((udp.src_port, udp.dst_port), (30490, 30490));
                        assert_eq!(someip.method_id, someip::SD_METHOD_ID);
                        assert_eq!(sd::parse(payload).unwrap().entries[0].ttl, 3);
                        saw_offer = true;
                    } else {
                        let expected = if someip.service_id == 0x1103 {
                            30501
                        } else {
                            30490
                        };
                        assert_eq!((udp.src_port, udp.dst_port), (expected, expected));
                        assert_eq!(someip.message_type, someip::MSG_NOTIFICATION);
                        assert_ne!(someip.method_id & 0x8000, 0);
                        saw_event = true;
                    }
                }
                gptp::ETHERTYPE_GPTP => match gptp::parse(ethernet.payload).unwrap().msg_type {
                    gptp::MSG_SYNC => saw_sync = true,
                    gptp::MSG_FOLLOW_UP => saw_follow_up = true,
                    other => panic!("unexpected gPTP message type {other}"),
                },
                other => panic!("unexpected EtherType {other:#06x}"),
            }
            if saw_event && saw_offer && saw_sync && saw_follow_up {
                break;
            }
        }
        assert!(saw_event && saw_offer && saw_sync && saw_follow_up);
        running.store(false, Ordering::Relaxed);
        worker.join().unwrap();
    }

    #[test]
    fn event_payload_is_catalog_decodable_and_zero_tailed() {
        let catalog =
            radeau_catalog::from_arxml(include_str!("../../../catalog/sensor-fusion.arxml"))
                .map(|(catalog, _)| catalog)
                .expect("checked-in extract");
        let mut noise = 7;
        let mut ident = 1;
        let wire = event(NODES[1], 0x8001, 10, &mut noise, &mut ident, &catalog);
        let ethernet = EthernetFrame::parse(&wire).expect("ethernet");
        let ip = Ipv4Packet::parse(ethernet.payload).expect("ipv4");
        let udp = UdpDatagram::parse(ip.payload).expect("udp");
        let (_, payload) = someip::parse(udp.payload).expect("someip");
        let event = catalog.event(0x1102, 0x8001).expect("radar event");
        let decoded = radeau_catalog::decode(&event.signals, payload);
        assert_eq!(decoded.len(), event.signals.len());
        assert!(decoded.iter().all(|signal| signal.scaled.is_finite()));
        let used = event
            .signals
            .iter()
            .map(|s| s.byte_offset + s.byte_len)
            .max()
            .unwrap_or(0);
        assert!(payload[used..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn background_frames_and_lidar_wire_policy() {
        let request = arp_frame(NODES[2], NODES[4], false);
        let eth = EthernetFrame::parse(&request).unwrap();
        assert_eq!(eth.vlan.map(|v| (v.vid, v.pcp)), Some((10, 5)));
        assert_eq!(
            ArpPacket::parse(eth.payload).unwrap().opcode,
            arp::OPCODE_REQUEST
        );
        let reply = arp_frame(NODES[4], NODES[2], true);
        assert_eq!(
            ArpPacket::parse(EthernetFrame::parse(&reply).unwrap().payload)
                .unwrap()
                .opcode,
            arp::OPCODE_REPLY
        );
        let rs = router_solicitation();
        let eth = EthernetFrame::parse(&rs).unwrap();
        let ip = Ipv6Packet::parse(eth.payload).unwrap();
        assert_eq!(
            ip.src,
            [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0x52, 0x41, 0xff, 0xfe, 0x44, 0, 5]
        );
        assert_eq!(ip.next_header, 58);
        assert_eq!(IcmpPacket::parse(ip.payload).unwrap().icmp_type, 133);
        let mut pseudo = Vec::new();
        pseudo.extend_from_slice(&ip.src);
        pseudo.extend_from_slice(&ip.dst);
        pseudo.extend_from_slice(&(ip.payload.len() as u32).to_be_bytes());
        pseudo.extend_from_slice(&[0, 0, 0, 58]);
        assert_eq!(radeau_proto::internet_checksum(&[&pseudo, ip.payload]), 0);
        assert_eq!(
            runt_frame(),
            vec![0x02, 0x52, 0x41, 0x44, 0, 5, 0x02, 0x52, 0x41, 0x44]
        );
    }

    #[test]
    fn icmpv6_checksum_matches_fixed_vector() {
        let src = [
            0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0x52, 0x41, 0xff, 0xfe, 0x44, 0, 5,
        ];
        let dst = [0xff, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
        let message = [133, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(icmpv6_checksum(src, dst, &message), 0x3c9c);
    }
}
