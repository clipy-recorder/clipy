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

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
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

const register = readFileSync(join(pluginsDir, "clipy-record", "hooks", "register.tsx"), "utf8");
assert.match(register, /\bconst MIN_VERSION\s*=\s*['"]0\.20\.0['"]/, "Record button MIN_VERSION must remain 0.20.0");
for (const rel of [
  join("plugins", "record", "skills", "record", "SKILL.md"),
  join("plugins", "clipy-record", "README.md"),
]) {
  assert.match(readFileSync(join(root, rel), "utf8"), /\b0\.20\.0 or later\b/, `${rel} must document the 0.20.0 CLI requirement`);
}

for (const file of files.filter((f) => /[\\/]skills[\\/].*SKILL\.md$/.test(f))) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file);
  const fallbackVersions = [...text.matchAll(/@clipy\/cli@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const featureRequirements = [...text.matchAll(/\bCLI\s+(\d+\.\d+\.\d+)\s+or later\b/gi)];
  if (featureRequirements.length === 0) continue;
  if (fallbackVersions.length === 0) {
    problems.push(`${rel}: CLI feature requirement has no pinned npx @clipy/cli fallback`);
    continue;
  }

  const paragraphs = text.split(/\n\s*\n/);
  for (const requirement of featureRequirements) {
    const minimum = requirement[1];
    const olderFallbacks = fallbackVersions.filter((version) => compareVersions(version, minimum) < 0);
    if (olderFallbacks.length === 0) continue;
    const paragraph = paragraphs.find((p) => p.includes(requirement[0])) ?? "";
    const explainsMissingFeature =
      /\b(?:npx\s+)?fallback\b.{0,120}\b(?:does not|doesn't|cannot|can't|won't)\s+(?:support|provide|include)\b/i.test(paragraph) ||
      /\b(?:npx\s+)?fallback\b.{0,120}\blacks\b/i.test(paragraph) ||
      /\b(?:feature|option)\b.{0,120}\b(?:is not|isn't)\s+(?:available|supported)\b.{0,120}\b(?:npx\s+)?fallback\b/i.test(paragraph);
    if (!explainsMissingFeature) {
      problems.push(`${rel}: CLI ${minimum} feature exceeds npx fallback version(s) ${olderFallbacks.join(", ")}`);
    }
  }
}

assert.deepEqual(problems, [], problems.join("\n"));
const cli = [...(versions.get("@clipy/cli") ?? [])];
const distinct = new Set(cli.map((v) => v.split(" ")[0]));
assert.ok(cli.length > 0, "expected the plugins to run @clipy/cli through npx");
assert.equal(distinct.size, 1, `plugins pin different @clipy/cli versions:\n${cli.join("\n")}`);
console.log(`plugin pins: ok (@clipy/cli@${[...distinct][0]} in ${cli.length} places)`);
