import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDesktopBuildNeeded } from "../../scripts/ci-path-filter.mjs";

describe("CI path filtering (Issue #18)", () => {
  it("skips desktop CI when only package files are modified", () => {
    const files = [
      "packages/transcribe/src/chunking.ts",
      "packages/transcribe/test/chunking.test.ts",
      "packages/config/src/index.ts",
      "packages/capture/src/proc.ts",
      "packages/moments/src/llm.ts",
    ];
    assert.equal(isDesktopBuildNeeded(files), false);
  });

  it("skips desktop CI when only docs and markdown files are modified", () => {
    const files = [
      "docs/offline-setup.md",
      "README.md",
      "CONTRIBUTING.md",
      "packages/capture/README.md",
    ];
    assert.equal(isDesktopBuildNeeded(files), false);
  });

  it("skips desktop CI when only examples are modified", () => {
    const files = [
      "examples/plan-moments.mjs",
      "examples/record-virtual-display.mjs",
      "examples/transcribe-file.mjs",
    ];
    assert.equal(isDesktopBuildNeeded(files), false);
  });

  it("skips desktop CI when git metadata files are modified", () => {
    const files = [
      ".gitignore",
      ".gitattributes",
      ".editorconfig",
    ];
    assert.equal(isDesktopBuildNeeded(files), false);
  });

  it("skips desktop CI for mixed packages, docs, and markdown changes", () => {
    const files = [
      "packages/config/config.schema.json",
      "packages/config/test/schema.test.ts",
      "docs/offline-setup.md",
      "README.md",
    ];
    assert.equal(isDesktopBuildNeeded(files), false);
  });

  it("triggers desktop CI when desktop UI components are modified", () => {
    const files = [
      "desktop/src/edition-local/LocalPreferences.tsx",
    ];
    assert.equal(isDesktopBuildNeeded(files), true);
  });

  it("triggers desktop CI when Rust crates or Tauri files are modified", () => {
    const files = [
      "desktop/src-tauri/crates/clipy-local-edition/src/settings.rs",
      "desktop/src-tauri/crates/clipy-local-moments/src/provider.rs",
      "desktop/src-tauri/Cargo.toml",
    ];
    assert.equal(isDesktopBuildNeeded(files), true);
  });

  it("triggers desktop CI when workflow files are modified", () => {
    const files = [
      ".github/workflows/ci.yml",
    ];
    assert.equal(isDesktopBuildNeeded(files), true);
  });

  it("triggers desktop CI when root package manifests or lockfiles are modified", () => {
    assert.equal(isDesktopBuildNeeded(["package.json"]), true);
    assert.equal(isDesktopBuildNeeded(["pnpm-lock.yaml"]), true);
    assert.equal(isDesktopBuildNeeded(["pnpm-workspace.yaml"]), true);
  });

  it("triggers desktop CI when root build/sync scripts are modified", () => {
    const files = [
      "scripts/sync-from-monorepo.mjs",
    ];
    assert.equal(isDesktopBuildNeeded(files), true);
  });

  it("triggers desktop CI for mixed changes touching both packages and desktop", () => {
    const files = [
      "packages/transcribe/src/chunking.ts",
      "desktop/src/edition-local/LocalPreferences.tsx",
    ];
    assert.equal(isDesktopBuildNeeded(files), true);
  });

  it("defaults to running desktop CI when changed file list is empty or undefined (fail-safe)", () => {
    assert.equal(isDesktopBuildNeeded([]), true);
    assert.equal(isDesktopBuildNeeded(null), true);
    assert.equal(isDesktopBuildNeeded(undefined), true);
  });
});
