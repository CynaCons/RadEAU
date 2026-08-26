// Duplicate requirement-ID check: a requirement ID may be DEFINED (appear as
// the first cell of a requirements-table row) in exactly one docs/SRS_*.md.
// References elsewhere are fine. Allocation registry: docs/REQUIREMENT_IDS.md.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const ROW = /^\|\s*([A-Z]{2})-(\d{3})\s*\|/;

const seen = new Map(); // id -> file
const dupes = [];

for (const name of readdirSync(docsDir)) {
  if (!/^SRS_.*\.md$/.test(name)) continue;
  const lines = readFileSync(join(docsDir, name), "utf8").split("\n");
  for (const line of lines) {
    const m = ROW.exec(line);
    if (!m) continue;
    const id = `${m[1]}-${m[2]}`;
    if (seen.has(id)) {
      dupes.push(`${id} defined in both ${seen.get(id)} and ${name}`);
    } else {
      seen.set(id, name);
    }
  }
}

if (dupes.length > 0) {
  console.error(`Duplicate requirement IDs (${dupes.length}):`);
  for (const d of dupes) console.error("  " + d);
  process.exit(1);
}
console.log(`Requirement IDs unique: ${seen.size} defined across docs/SRS_*.md.`);
