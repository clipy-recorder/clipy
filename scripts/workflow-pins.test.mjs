#!/usr/bin/env node
/**
 * Every action a workflow uses is pinned to a full 40-character commit SHA,
 * with the version it stands for in a comment (`# v5.0.1`). A tag such as
 * `@v5` can be moved to different code after review; a SHA cannot. Dependabot
 * (.github/dependabot.yml) keeps the SHAs and their comments current.
 *
 * dtolnay/rust-toolchain is released as branches named after Rust versions,
 * so its pin has no version comment and is allowed without one.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github", "workflows");
const noVersionComment = new Set(["dtolnay/rust-toolchain"]);

const files = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => join(workflowsDir, name));
const problems = [];
let pinned = 0;
for (const file of files) {
  const rel = relative(root, file);
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const m = line.match(/^\s*(?:-\s+)?uses:\s*(.*)$/);
      if (!m) return;
      const where = `${rel}:${i + 1}`;
      const hash = m[1].search(/\s#/);
      const spec = (hash === -1 ? m[1] : m[1].slice(0, hash)).trim().replace(/^(["'])(.*)\1$/, "$2");
      const comment = hash === -1 ? "" : m[1].slice(hash).trim();
      if (spec.startsWith("./")) return; // a local action comes from the same commit
      const at = spec.lastIndexOf("@");
      const action = at > 0 ? spec.slice(0, at) : spec;
      const ref = at > 0 ? spec.slice(at + 1) : "";
      if (!/^[0-9a-f]{40}$/.test(ref)) {
        problems.push(`${where}: ${spec} is not pinned to a 40-character commit SHA`);
      } else if (!/^#\s*v\d/.test(comment) && !noVersionComment.has(action)) {
        problems.push(`${where}: ${action} is pinned but has no "# vX" comment naming its version`);
      } else {
        pinned++;
      }
    });
}

assert.deepEqual(problems, [], problems.join("\n"));
assert.ok(pinned > 0, "expected the workflows to use at least one action");
console.log(`workflow pins: ok (${pinned} actions in ${files.length} workflow files)`);
