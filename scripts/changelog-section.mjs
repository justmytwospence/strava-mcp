#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section of one version, for the GitHub Release notes:
 *
 *   node scripts/changelog-section.mjs v4.3.0 > notes.md
 *
 * Accepts the tag (v4.3.0) or the bare version (4.3.0), finds the heading
 * `## [4.3.0] - YYYY-MM-DD` (the date is optional), and prints everything up to the
 * next `## ` heading or the link references at the end, without the heading itself.
 * Exits 1 when the section is missing or empty, so a release without notes fails
 * loudly instead of publishing an empty page.
 */
import { readFileSync } from "node:fs";

const [tag, file = "CHANGELOG.md"] = process.argv.slice(2);
if (!tag) {
  console.error("usage: changelog-section.mjs <vX.Y.Z | X.Y.Z> [CHANGELOG.md]");
  process.exit(2);
}
const version = tag.replace(/^v/, "");
const lines = readFileSync(file, "utf8").split("\n");
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](\\s+-\\s+\\S+)?\\s*$`);
const start = lines.findIndex((line) => heading.test(line));
if (start < 0) {
  console.error(`${file}: no "## [${version}]" section`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i]) || /^\[[^\]]+\]:\s+\S+/.test(lines[i])) {
    end = i;
    break;
  }
}
const body = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!body) {
  console.error(`${file}: the "## [${version}]" section is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
