#!/usr/bin/env node
/**
 * Generates the open-source copies of shared monorepo code.
 *
 * While the local edition is staged, the monorepo is the source of truth: the
 * cloud product keeps importing these files from lib/ unchanged, and this
 * script copies them into packages/moments/src/generated with their `@/`
 * imports rewritten. The generated files are gitignored in the monorepo and
 * committed only in the exported repo.
 *
 * Every generated file has all comments removed (the TypeScript printer
 * re-emits the code without them; string literals are checked to be
 * unchanged), then gets an SPDX line and a GENERATED line. A guard then
 * refuses to write anything if a generated file still contains a term that
 * must not be published (see FORBIDDEN).
 *
 * Run from anywhere: `node oss/scripts/sync-from-monorepo.mjs`.
 * Outside the monorepo (in the exported repo) lib/ is absent and this is a no-op.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = join(here, "..");
const repo = join(ossRoot, "..");
const lib = join(repo, "lib");
const HEADER = (src) =>
  "// SPDX-License-Identifier: Apache-2.0\n" +
  `// GENERATED from ${src} Do not edit here. Edit the monorepo source and re-run oss/scripts/sync-from-monorepo.mjs.\n`;

/**
 * Terms that must never reach a generated file: internal notes, internal
 * docs, private paths. Matched case-insensitively on the final output.
 */
export const FORBIDDEN = ["owner", "AGENTS.md", "CLAUDE.md", "desktop/src-tauri", "/home/", "/Users/"];

/**
 * More terms (real recording ids, people, other companies) that would be a
 * leak in themselves if listed here, so they live in a file the export never
 * copies (scripts/export.mjs, MONOREPO_ONLY). Required wherever lib/ is.
 */
export const INTERNAL_TERMS_FILE = join(here, "internal-terms.json");

function loadInternalTerms() {
  if (!existsSync(INTERNAL_TERMS_FILE)) return [];
  const terms = JSON.parse(readFileSync(INTERNAL_TERMS_FILE, "utf8"));
  if (!Array.isArray(terms) || !terms.every((t) => typeof t === "string" && t.length > 0)) {
    throw new Error(`${INTERNAL_TERMS_FILE} must be a JSON array of non-empty strings`);
  }
  return terms;
}

/** Every forbidden term in `text`, with the line it is on. */
export function findForbidden(text, terms = [...FORBIDDEN, ...loadInternalTerms()]) {
  const hits = [];
  const lines = text.split("\n");
  for (const term of terms) {
    const needle = term.toLowerCase();
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(needle)) hits.push({ term, line: i + 1, text: line.trim().slice(0, 160) });
    });
  }
  return hits;
}

/** Import specifiers the moments package resolves locally. Anything else under `@/` is an error. */
const MOMENTS_IMPORTS = {
  "@/lib/server/momentPlanner": "./types.js",
  "@/lib/models/keyMoments": "./types.js",
  "@/lib/animation-editor/drawStrokes": "./drawStrokes.js",
  // lib/elementSelector re-exports these validators from lib/browserDiagnostics,
  // which has no imports and already ships in the public extension.
  "@/lib/elementSelector": "./browserDiagnostics.js",
  "@/lib/queue/keyMomentsCursorContext": "./keyMomentsCursorContext.js",
  "@/lib/queue/keyMomentsFusion": "./keyMomentsFusion.js",
  "@/lib/llm/openrouter": "../llm.js",
};

/**
 * Exact code replacements per generated file, applied before comments are
 * stripped. Each must match exactly once, so a change in lib/ fails loudly
 * here instead of silently diverging.
 *
 * The planner classifies model errors by message prefix. The hosted client
 * names OpenRouter; the open client talks to any provider, so its messages
 * (moments/src/llm.ts, MODEL_ERROR) are provider-neutral and the prefixes
 * follow them.
 */
const REPLACEMENTS = {
  "server/localMomentPlan.ts": [
    ["startsWith('OpenRouter JSON parse failed')", "startsWith('Model provider JSON parse failed')"],
    ["startsWith('OpenRouter returned no completion')", "startsWith('Model provider returned no completion')"],
  ],
};

function rewrite(source, file, imports = MOMENTS_IMPORTS) {
  let out = source.replace(/(from\s+['"])(@\/[^'"]+)(['"])/g, (_m, pre, spec, post) => {
    const mapped = imports[spec];
    if (!mapped) throw new Error(`${file}: unmapped import ${spec}. Map it in the sync script or keep it out of the open package.`);
    return `${pre}${mapped}${post}`;
  });
  // NodeNext ESM needs explicit extensions on relative imports.
  out = out.replace(/(from\s+['"]\.\.?\/[^'"]+?)(['"])/g, (_m, path, quote) =>
    path.endsWith(".js") ? `${path}${quote}` : `${path}.js${quote}`);
  for (const [from, to] of REPLACEMENTS[file] ?? []) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`${file}: expected exactly one "${from}", found ${count}. Update REPLACEMENTS in the sync script.`);
    out = out.replace(from, to);
  }
  return out;
}

/** Pull one exported declaration out of a file, so the open package never imports a DB module. */
function extract(file, start, endTest) {
  const lines = readFileSync(join(lib, file), "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith(start));
  if (from < 0) throw new Error(`${file}: "${start}" not found`);
  const to = lines.findIndex((l, i) => i >= from && endTest(l));
  if (to < 0) throw new Error(`${file}: end of "${start}" not found`);
  return lines.slice(from, to + 1).join("\n");
}

/** TypeScript from this workspace, or from a package or monorepo install next to it. */
function loadTypeScript() {
  const anchors = [
    join(ossRoot, "package.json"),
    join(ossRoot, "packages", "moments", "package.json"),
    join(repo, "package.json"),
    join(repo, "cli", "package.json"),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)("typescript");
    } catch {
      // try the next install
    }
  }
  throw new Error("typescript is not installed: run `pnpm install` in oss/ first");
}

/** Every string, template and regex literal in a file, in source order. */
function literals(ts, sourceFile) {
  const out = [];
  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      out.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Positions in `sourceFile` where a comment remains. */
function commentsLeft(ts, sourceFile) {
  const text = sourceFile.getFullText();
  const found = new Set();
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) found.add(r.pos);
    for (const r of ts.getTrailingCommentRanges(text, node.end) ?? []) found.add(r.pos);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const r of ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.pos) ?? []) found.add(r.pos);
  return [...found];
}

/**
 * Remove every comment from a TypeScript file, keeping its code. Fails if a
 * literal changed or a comment survived, so a printer quirk cannot publish
 * altered prompts or leftover notes.
 */
function stripComments(ts, text, name) {
  const parse = (t) => ts.createSourceFile(name, t, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const source = parse(text);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const printed = printer.printFile(source);
  const reparsed = parse(printed);
  if (reparsed.parseDiagnostics?.length) throw new Error(`${name}: the comment-free output does not parse`);
  const before = literals(ts, source);
  const after = literals(ts, reparsed);
  if (before.length !== after.length || before.some((lit, i) => lit !== after[i])) {
    const i = before.findIndex((lit, j) => lit !== after[j]);
    throw new Error(`${name}: removing comments changed a literal: ${JSON.stringify(before[i])} became ${JSON.stringify(after[i])}`);
  }
  const left = commentsLeft(ts, reparsed);
  if (left.length) throw new Error(`${name}: ${left.length} comment(s) survived at offsets ${left.slice(0, 5).join(", ")}`);
  return printed;
}

function main() {
  if (!existsSync(join(lib, "queue", "keyMomentsFusion.ts"))) {
    process.stderr.write("[sync] monorepo lib/ not found, keeping existing generated files\n");
    return;
  }
  if (!existsSync(INTERNAL_TERMS_FILE)) {
    throw new Error(`${INTERNAL_TERMS_FILE} is missing: the guard needs it inside the monorepo`);
  }
  const ts = loadTypeScript();
  const outDir = join(ossRoot, "packages", "moments", "src", "generated");

  /** generated file name -> final contents */
  const files = new Map();
  const copies = [
    ["queue/keyMomentsCursorContext.ts", "keyMomentsCursorContext.ts"],
    ["queue/keyMomentsFusion.ts", "keyMomentsFusion.ts"],
    ["animation-editor/drawStrokes.ts", "drawStrokes.ts"],
    ["browserDiagnostics.ts", "browserDiagnostics.ts"],
    ["server/localMomentPlan.ts", "localMomentPlan.ts"],
  ];
  for (const [src, dest] of copies) {
    const code = rewrite(readFileSync(join(lib, src), "utf8"), src);
    files.set(dest, HEADER(`lib/${src}`) + stripComments(ts, code, dest));
  }

  const closesBlock = (l) => l === "}";
  const types = [
    extract("server/momentPlanner.ts", "export interface PlannedMoment", closesBlock),
    extract("models/keyMoments.ts", "export type KeyMomentSource", (l) => l.trimEnd().endsWith(";")),
    extract("models/keyMoments.ts", "export interface KeyMomentInput", closesBlock),
  ].join("\n\n");
  files.set(
    "types.ts",
    HEADER("lib/server/momentPlanner.ts and lib/models/keyMoments.ts (types only)") + stripComments(ts, types, "types.ts"),
  );

  // Guard: nothing internal reaches the published copy. Comments are already
  // gone, so a hit here is code or a string literal; fix it in lib/.
  const hits = [...files].flatMap(([name, text]) => findForbidden(text).map((h) => ({ name, ...h })));
  if (hits.length) {
    for (const h of hits) process.stderr.write(`[sync] ${h.name}:${h.line} contains "${h.term}": ${h.text}\n`);
    rmSync(outDir, { recursive: true, force: true });
    process.stderr.write("[sync] refusing to generate files that contain internal terms (listed above)\n");
    process.exit(1);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(outDir, name), text);

  // The test fixture is synthetic and committed (packages/moments/test/fixtures);
  // nothing from lib/ is copied for it.
  process.stdout.write(`[sync] wrote ${files.size} files to packages/moments/src/generated\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
