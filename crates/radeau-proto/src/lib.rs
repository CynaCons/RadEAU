//! Shared protocol codecs for RadEAU and `ecu-netsim`.
//!
//! One codec, tested once (decision D9): Ethernet II / 802.1Q / IPv4 / UDP
//! framing, the SOME/IP header, SOME/IP-SD payloads, and gPTP messages, all
//! specified in `docs/SRS_protocols.md`. Implemented in v0.3.0; this crate
//! exists from the first commit so the workspace dependency graph — app core
//! and simulator both consuming one codec crate — is real from day one.
//!
//! Codec rules (normative): bounded, panic-free on malformed input; all
//! multi-byte SOME/IP fields big-endian; a payload shorter than a field's
//! extent yields *missing*, never a partial value.

pub const CRATE_NAME: &str = "radeau-proto";

#[cfg(test)]
mod tests {
    #[test]
    fn workspace_wiring() {
        assert_eq!(super::CRATE_NAME, "radeau-proto");
    }
}
