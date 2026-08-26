//! `ecu-netsim` — RadEAU's companion ECU network simulator.
//!
//! Implemented in v0.4 per `docs/SRS_ecu_netsim.md`: virtual switch, SOME/IP
//! runtime with service discovery, gPTP, the sensor-fusion scenario, fault
//! injection, and the monitor/inject (5560) + control (5561) links. This
//! skeleton pins the binary, its CLI surface, and the shared-codec dependency
//! into the workspace from the first commit.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("ecu-netsim {} (codec: {})", env!("CARGO_PKG_VERSION"), radeau_proto::CRATE_NAME);
        return;
    }
    eprintln!(
        "ecu-netsim {}: simulator not yet implemented (arrives in v0.4).\n\
         Planned usage: ecu-netsim --scenario <file> [--seed <n>] [--accelerated]\n\
         [--monitor-port 5560] [--control-port 5561]",
        env!("CARGO_PKG_VERSION")
    );
    std::process::exit(2);
}
