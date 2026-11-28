#!/usr/bin/env node
/**
 * Every package a plugin runs through npx is pinned to an exact version, and
 * all plugins pin the same @clipy/cli. The Claude plugin directory refuses
 * unpinned npx packages, and a skill pinned to an older CLI than the Record
 * button would behave differently in the same session.
 *
 * When a new @clipy/cli is released, bump every pin in plugins/ together.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "plugins");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(pluginsDir).filter((f) => /\.(md|tsx?|json|mjs|js)$/.test(f));
const versions = new Map();
const problems = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file);
  for (const m of text.matchAll(/npx(?:'|")?\s*,?\s*(?:'|")?(?:-y(?:'|")?\s*,?\s*(?:'|")?)?(@?[a-z0-9@/._-]+)/gi)) {
    const spec = m[1];
    const at = spec.lastIndexOf("@");
    const version = at > 0 ? spec.slice(at + 1) : "";
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      problems.push(`${rel}: npx ${spec} is not pinned to an exact version`);
      continue;
    }
    const name = spec.slice(0, at);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(`${version} (${rel})`);
  }
}

assert.deepEqual(problems, [], problems.join("\n"));
const cli = [...(versions.get("@clipy/cli") ?? [])];
const distinct = new Set(cli.map((v) => v.split(" ")[0]));
assert.ok(cli.length > 0, "expected the plugins to run @clipy/cli through npx");
assert.equal(distinct.size, 1, `plugins pin different @clipy/cli versions:\n${cli.join("\n")}`);
// The minimum CLI version the plugins ask for must be the same everywhere, and
// the pinned npx fallback must satisfy it.
const pinned = [...distinct][0];
const VERSION = "(\\d+\\.\\d+\\.\\d+)";
const compare = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const minimums = [
  ["plugins/clipy-record/hooks/register.tsx", new RegExp(`const MIN_VERSION = '${VERSION}'`)],
  ["plugins/record/skills/record/SKILL.md", new RegExp(`version is\\s+${VERSION}\\s+or later`)],
  ["plugins/clipy-record/README.md", new RegExp(`needs version\\s+${VERSION}\\s+or later`)],
].map(([rel, re]) => {
  const match = re.exec(readFileSync(join(root, rel), "utf8"));
  assert.ok(match, `${rel}: could not find the minimum @clipy/cli version (${re})`);
  return { rel, version: match[1] };
});
const minVersions = new Set(minimums.map((m) => m.version));
assert.equal(
  minVersions.size,
  1,
  `the minimum @clipy/cli version differs between files:\n${minimums.map((m) => `${m.version} (${m.rel})`).join("\n")}`,
);
const minVersion = minimums[0].version;
assert.ok(compare(minVersion, pinned) <= 0, `the minimum @clipy/cli version ${minVersion} is newer than the pinned npx fallback ${pinned}`);

// A skill may mention a "CLI X.Y.Z or later" feature that the pinned npx
// fallback does not have, but it must say so on the same line.
const featureProblems = [];
for (const file of files.filter((f) => f.endsWith("SKILL.md"))) {
  const rel = relative(root, file);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      for (const m of line.matchAll(new RegExp(`CLI ${VERSION} or later`, "g"))) {
        if (compare(m[1], pinned) > 0 && !/fallback[^|]*\blacks\b/i.test(line)) {
          featureProblems.push(`${rel}:${index + 1}: needs CLI ${m[1]} but the npx fallback pins ${pinned}; say that the fallback lacks it`);
        }
      }
    });
}
assert.deepEqual(featureProblems, [], featureProblems.join("\n"));

console.log(`plugin pins: ok (@clipy/cli@${pinned} in ${cli.length} places, minimum ${minVersion})`);
