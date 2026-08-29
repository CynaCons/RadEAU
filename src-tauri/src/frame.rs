//! Source-neutral classified frame projection used by every capture reader.
pub const SNAP_LEN: usize = 12;

#[derive(Debug, Clone)]
pub struct GenFrame {
    pub idx: u64,
    pub t_s: f64,
    pub dir: u8,
    pub src_ep: usize,
    pub proto: u8,
    pub svc: u16,
    pub method: u16,
    pub msg_type: u8,
    pub session: i32,
    pub wire_len: u32,
    pub snap: [u8; SNAP_LEN],
    pub src_ip: u32,
    pub dst_ip: u32,
    pub src_mac: u64,
    pub vlan: i16,
    pub payload_off: u16,
}
