// Raw-color-literal lint (VU-002): fails the build on any hex or rgb()/rgba()
// literal outside the token module and its generated mirror.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// tokens.test.ts asserts the token VALUES (VU-004) — a deliberate mirror of
// the source, not a divergent literal.
const ALLOWED = new Set(["src/theme/tokens.json", "src/theme/tokens.css", "src/theme/tokens.test.ts"]);
const EXTS = new Set([".ts", ".tsx", ".css", ".html", ".json"]);
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB = /\brgba?\(/g;

const violations = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (["node_modules", "dist", "target", ".git"].includes(name)) continue;
      walk(p);
    } else {
      const rel = relative(root, p).split(sep).join("/");
      const ext = rel.slice(rel.lastIndexOf("."));
      if (!EXTS.has(ext)) continue;
      if (ALLOWED.has(rel)) continue;
      if (!rel.startsWith("src/") && rel !== "index.html") continue;
      const text = readFileSync(p, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (HEX.test(line) || RGB.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
        HEX.lastIndex = 0;
        RGB.lastIndex = 0;
      });
    }
  }
}

walk(root);

if (violations.length > 0) {
  console.error(`Raw color literals outside the token module (${violations.length}):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("No raw color literals outside src/theme/tokens.json.");
