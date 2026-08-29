import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as wire from "./wireCodes";
import { PROTO_CLASS_COUNT, PROTO_LABELS } from "./wireCodes";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUST_CODES = join(repoRoot, "src-tauri", "src", "codes.rs");

/** Extract `pub const NAME: u8|usize = N;` bindings from codes.rs. */
function parseRustConsts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /pub const ([A-Z0-9_]+):\s*(?:u8|usize)\s*=\s*(\d+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.set(m[1], Number(m[2]));
  }
  return out;
}

/** Exported numeric constants from wireCodes.ts (skip functions / arrays). */
function tsNumericExports(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, value] of Object.entries(wire)) {
    if (typeof value === "number") out.set(name, value);
  }
  return out;
}

describe("wireCodes ↔ codes.rs mirror", () => {
  const rustSrc = readFileSync(RUST_CODES, "utf8");
  const rust = parseRustConsts(rustSrc);
  const ts = tsNumericExports();

  it("parses every Rust pub const from codes.rs", () => {
    expect(rust.size).toBeGreaterThan(20);
    expect(rust.get("PROTO_SOMEIP")).toBe(0);
    expect(rust.get("PROTO_CLASS_COUNT")).toBe(12);
    expect(rust.get("DIR_UNKNOWN")).toBe(2);
    expect(rust.get("ENDPOINT_OVERFLOW")).toBe(255);
  });

  it("every Rust constant exists in wireCodes.ts with the same value", () => {
    for (const [name, value] of rust) {
      expect(ts.has(name), `missing in wireCodes.ts: ${name}`).toBe(true);
      expect(ts.get(name), `value mismatch for ${name}`).toBe(value);
    }
  });

  it("every exported numeric constant in wireCodes.ts exists in codes.rs", () => {
    for (const [name, value] of ts) {
      expect(rust.has(name), `extra in wireCodes.ts (not in codes.rs): ${name}`).toBe(true);
      expect(rust.get(name), `value mismatch for ${name}`).toBe(value);
    }
  });

  it("PROTO_LABELS.length === PROTO_CLASS_COUNT", () => {
    expect(PROTO_LABELS.length).toBe(PROTO_CLASS_COUNT);
  });
});
