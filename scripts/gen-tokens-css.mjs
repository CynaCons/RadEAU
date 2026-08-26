// Generates src/theme/tokens.css (CSS custom properties on :root) from the
// single token source src/theme/tokens.json. Run `npm run gen:tokens`;
// `--check` verifies the committed file is in sync (CI).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(root, "src/theme/tokens.json"), "utf8"));

let css = `/* GENERATED FILE — do not edit. Source: src/theme/tokens.json (npm run gen:tokens). */\n:root {\n`;
for (const [name, value] of Object.entries(tokens.color)) {
  css += `  --${name}: ${value};\n`;
}
tokens.series.forEach((value, i) => {
  css += `  --series-${i + 1}: ${value};\n`;
});
css += `  --font-ui: ${tokens.font.ui};\n`;
css += `  --font-mono: ${tokens.font.mono};\n`;
css += `}\n`;

const out = join(root, "src/theme/tokens.css");
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    /* missing counts as out of sync */
  }
  if (current !== css) {
    console.error("tokens.css is out of sync with tokens.json — run `npm run gen:tokens`.");
    process.exit(1);
  }
  console.log("tokens.css in sync.");
} else {
  writeFileSync(out, css);
  console.log("tokens.css generated.");
}
