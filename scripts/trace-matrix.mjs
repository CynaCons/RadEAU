// Requirement traceability (ASPICE SWE.1 <-> SWE.3/SWE.4/SWE.6): builds the
// requirement -> implementation -> test matrix from the SRS tables and the
// source tree, writes docs/TRACEABILITY.md, and with --check fails when:
//   - a row's Status is not one of STATUSES;
//   - an Implemented or Verified requirement has no implementation trace;
//   - a Verified requirement has no test trace (unit test or E2E);
//   - code or tests reference a requirement ID that no SRS row defines.
// Planned/Deferred/Superseded rows need no trace. Implemented rows without a
// test trace are the verification gap: listed and counted, not failed — the
// status says honestly that they are not yet verified. Source files carrying
// no requirement reference are listed as untraced code (reported, not failed).
//
// Trace convention: mention the ID (e.g. `CP-014`) in a comment at the
// implementing code and in the verifying test (test name, comment, or
// describe/it title). Tests = *.test.ts(x), Rust code after `#[cfg(test)]`,
// files under */tests/, and scripts/e2e-*.mjs.
//
//   node scripts/trace-matrix.mjs           regenerate docs/TRACEABILITY.md
//   node scripts/trace-matrix.mjs --check   also fail on violations (CI)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const STATUSES = ["Planned", "Implemented", "Verified", "Deferred", "Superseded"];
const NEEDS_IMPL = new Set(["Implemented", "Verified"]);
const ID = /\b([A-Z]{2})-(\d{3})\b/g;
const ROW = /^\|\s*([A-Z]{2}-\d{3})\s*\|/;
// Table cells, honouring escaped pipes ("\|") inside cell text.
const cellsOf = (line) => line.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));

// Prefixes the registry allocates (docs/REQUIREMENT_IDS.md).
const PREFIXES = new Set(
  [...readFileSync(join(docsDir, "REQUIREMENT_IDS.md"), "utf8").matchAll(/^\|\s*([A-Z]{2})-\s*\|/gm)].map(
    (m) => m[1],
  ),
);

// --- requirements ----------------------------------------------------------
const reqs = new Map(); // id -> { id, file, text, status }
const problems = [];
for (const name of readdirSync(docsDir).sort()) {
  if (!/^SRS_.*\.md$/.test(name)) continue;
  let statusCol = -1;
  for (const line of readFileSync(join(docsDir, name), "utf8").split(/\r?\n/)) {
    if (/^\|\s*ID\s*\|/.test(line)) {
      const cells = cellsOf(line);
      statusCol = cells.indexOf("Status");
      continue;
    }
    const m = ROW.exec(line);
    if (!m) continue;
    const cells = cellsOf(line);
    const status = statusCol > 0 ? (cells[statusCol] ?? "") : "";
    const head = status.split(/[\s(]/)[0];
    if (!STATUSES.includes(head)) {
      problems.push(`${m[1]} (${name}): status "${status}" is not one of ${STATUSES.join("/")}`);
    }
    reqs.set(m[1], { id: m[1], file: name, text: cells[2] ?? "", status: head || status });
  }
}

// --- source scan -----------------------------------------------------------
const SKIP = new Set(["node_modules", "target", "dist", "dist-portable", ".git", "gen", "fixtures"]);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(rs|ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = [
  ...walk(join(root, "src"), []),
  ...walk(join(root, "src-tauri", "src"), []),
  ...walk(join(root, "crates"), []),
  ...walk(join(root, "scripts"), []).filter((p) => /[\\/]e2e-[^\\/]*\.mjs$/.test(p)),
];

const impl = new Map(); // id -> Set(file)
const tests = new Map(); // id -> Set(file)
const untraced = [];
const add = (map, id, file) => {
  if (!map.has(id)) map.set(id, new Set());
  map.get(id).add(file);
};

for (const abs of files) {
  const rel = relative(root, abs).replaceAll("\\", "/");
  const text = readFileSync(abs, "utf8");
  const wholeTest =
    /\.test\.tsx?$/.test(rel) || /\/tests\//.test(rel) || /^scripts\/e2e-/.test(rel);
  // Rust: everything from the first #[cfg(test)] on is test code.
  const cut = !wholeTest && rel.endsWith(".rs") ? text.indexOf("#[cfg(test)]") : -1;
  const parts = wholeTest
    ? [["test", text]]
    : cut >= 0
      ? [["impl", text.slice(0, cut)], ["test", text.slice(cut)]]
      : [["impl", text]];
  let any = false;
  for (const [kind, chunk] of parts) {
    for (const m of chunk.matchAll(ID)) {
      const id = `${m[1]}-${m[2]}`;
      if (!reqs.has(id)) {
        // Only flag prefixes the registry owns (avoid e.g. "UTF-008" noise).
        if (PREFIXES.has(m[1])) problems.push(`${id} referenced in ${rel} but defined in no SRS`);
        continue;
      }
      any = true;
      add(kind === "test" ? tests : impl, id, rel);
    }
  }
  if (!any && !wholeTest && /^(src|src-tauri\/src|crates\/[^/]+\/src)\//.test(rel)) untraced.push(rel);
}

// --- checks ----------------------------------------------------------------
const unverified = [];
for (const r of reqs.values()) {
  if (!NEEDS_IMPL.has(r.status)) continue;
  if (!impl.has(r.id)) problems.push(`${r.id} is ${r.status} but no implementation references it`);
  if (!tests.has(r.id)) {
    if (r.status === "Verified") problems.push(`${r.id} is Verified but no test references it`);
    else unverified.push(r.id);
  }
}

// --- report ----------------------------------------------------------------
const byStatus = {};
for (const r of reqs.values()) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const fmt = (set) => (set ? [...set].sort().map((f) => `\`${f}\``).join("<br>") : "—");
const esc = (s) => s.replaceAll("|", "\\|");
let md = `# Requirement traceability matrix

Generated by \`node scripts/trace-matrix.mjs\` — do not edit by hand. Rows come
from the requirement tables in \`docs/SRS_*.md\`; traces are requirement IDs
mentioned in implementation code and in tests (unit tests, Rust \`#[cfg(test)]\`
modules, \`scripts/e2e-*.mjs\`). CI runs it with \`--check\`: Implemented and
Verified requirements need an implementation trace; Verified ones also a test
trace. Implemented-without-test is the open verification gap listed below.

**${reqs.size} requirements** — ${Object.entries(byStatus)
  .sort()
  .map(([k, v]) => `${k} ${v}`)
  .join(" · ")}

`;
for (const name of [...new Set([...reqs.values()].map((r) => r.file))]) {
  md += `## ${name}\n\n| ID | Status | Requirement | Implementation | Tests |\n|---|---|---|---|---|\n`;
  for (const r of reqs.values()) {
    if (r.file !== name) continue;
    const text = r.text.length > 110 ? `${r.text.slice(0, 107)}…` : r.text;
    md += `| ${r.id} | ${r.status} | ${esc(text)} | ${fmt(impl.get(r.id))} | ${fmt(tests.get(r.id))} |\n`;
  }
  md += "\n";
}
md += `## Verification gap

Implemented requirements with no test trace yet (${unverified.length}): ${unverified.length ? unverified.join(", ") : "none"}.

`;
md += `## Untraced source files\n\nImplementation files that reference no requirement (${untraced.length}). Each is either covered by a requirement that should name it, or is infrastructure.\n\n`;
md += untraced.length ? `${untraced.sort().map((f) => `- \`${f}\``).join("\n")}\n` : "None.\n";
writeFileSync(join(docsDir, "TRACEABILITY.md"), md);

console.log(
  `Traceability: ${reqs.size} requirements (${Object.entries(byStatus)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}), ${unverified.length} implemented but unverified, ${untraced.length} untraced source files -> docs/TRACEABILITY.md`,
);
if (process.argv.includes("--check")) {
  if (problems.length) {
    console.error(`Traceability violations (${problems.length}):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("Traceability check: OK");
}
