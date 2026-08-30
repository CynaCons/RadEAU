/**
 * Prints the CHANGELOG.md section for one version — the GitHub release body.
 *
 * Run: node scripts/release-notes.mjs v0.1.12
 * Exits non-zero when the version has no section, so a tag without notes
 * fails the release workflow instead of publishing an empty page.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) {
  console.error("usage: node scripts/release-notes.mjs vX.Y.Z");
  process.exit(2);
}

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8").replace(/\r\n/g, "\n");
const lines = changelog.split("\n");
const start = lines.findIndex((l) => l.startsWith(`## v${version} `) || l === `## v${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no section for v${version}`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}
// Drop the section heading itself; promote the sub-headings back one level.
const body = lines
  .slice(start + 1, end)
  .map((l) => (l.startsWith("### ") ? l.slice(1) : l))
  .join("\n")
  .trim();
process.stdout.write(`${body}\n`);
