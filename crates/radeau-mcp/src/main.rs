//! `radeau-mcp`: the MCP stdio bridge an AI agent launches (AU-008); it ships
//! next to `radeau` in the release zip and tarball (AU-010).
fn main() -> std::io::Result<()> {
    radeau_mcp::run_stdio()
}
