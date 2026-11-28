#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";

/**
 * Determines whether desktop CI jobs should run for a given list of changed files.
 * Returns true if desktop CI should run, false if changes only touch packages, docs, examples, or markdown.
 *
 * @param {string[] | null | undefined} changedFiles
 * @returns {boolean}
 */
export function isDesktopBuildNeeded(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) {
    // If no changed files detected (or push to main / manual run), default to true (safe).
    return true;
  }

  // Files/patterns that are considered packages-only or docs-only (do not need desktop CI)
  const isPackageOrDoc = (file) => {
    const f = file.replace(/\\/g, "/").trim();
    if (!f) return true;
    if (f.startsWith("packages/")) return true;
    if (f.startsWith("docs/")) return true;
    if (f.startsWith("examples/")) return true;
    if (f.endsWith(".md")) return true;
    if (f === ".gitignore" || f === ".gitattributes" || f === ".editorconfig") return true;
    return false;
  };

  // If every single changed file is a package, doc, example, markdown, or git config, desktop is NOT needed.
  const onlyPackagesOrDocs = changedFiles.every(isPackageOrDoc);
  return !onlyPackagesOrDocs;
}

/**
 * Retrieves the list of changed files from git.
 *
 * @returns {string[] | null}
 */
export function getChangedFiles() {
  const eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || "";
  if (eventName && eventName !== "pull_request") {
    // Direct pushes to main or workflow_dispatch always trigger full build
    return null;
  }

  const baseRef = process.env.BASE_REF || process.env.GITHUB_BASE_REF || "main";

  // Try candidate commands in order of precision:
  const candidates = [
    // GitHub Actions PR merge commit has 2 parents: HEAD^1 is base, HEAD^2 is PR head
    "git diff --name-only HEAD^1 HEAD^2",
    "git diff --name-only HEAD^1 HEAD",
    `git diff --name-only origin/${baseRef}...HEAD`,
    `git diff --name-only ${baseRef}...HEAD`,
    "git diff --name-only HEAD~1 HEAD",
  ];

  for (const cmd of candidates) {
    try {
      const output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const files = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (files.length > 0) {
        return files;
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

// When run directly as a script
if (process.argv[1] && (process.argv[1].endsWith("ci-path-filter.mjs") || process.argv[1].endsWith("ci-path-filter"))) {
  let needed = true;
  try {
    const eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || "";
    if (eventName && eventName !== "pull_request") {
      console.log(`[ci-path-filter] Event is "${eventName}" (not pull_request). Running full desktop CI.`);
      needed = true;
    } else {
      const files = getChangedFiles();
      if (!files) {
        console.log("[ci-path-filter] Unable to determine changed files; falling back to full desktop CI.");
        needed = true;
      } else {
        needed = isDesktopBuildNeeded(files);
        console.log(`[ci-path-filter] Detected changed files (${files.length}):`);
        for (const file of files) {
          console.log(`  - ${file}`);
        }
        console.log(`[ci-path-filter] Desktop CI needed: ${needed}`);
      }
    }
  } catch (err) {
    console.error("[ci-path-filter] Error evaluating changes:", err);
    needed = true; // Safe fallback on error
  }

  // Set GitHub Actions output if running in workflow
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `desktop=${needed}\n`, "utf8");
    console.log(`[ci-path-filter] Wrote desktop=${needed} to GITHUB_OUTPUT.`);
  }
}
