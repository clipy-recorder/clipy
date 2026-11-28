#!/usr/bin/env node
// Keep the marketplace install paths and plugin metadata in sync.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));

for (const plugin of marketplace.plugins) {
  test(`marketplace plugin ${plugin.name} has matching files and metadata`, () => {
    assert.equal(typeof plugin.source, "string", `${plugin.name}: expected a local source folder`);
    const source = resolve(root, plugin.source);
    assert.ok(statSync(source).isDirectory(), `${plugin.name}: source is not a directory`);
    const manifestPath = join(source, ".claude-plugin/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, plugin.name, `${plugin.source}: marketplace and manifest names differ`);
    assert.ok(statSync(join(source, "README.md")).isFile(), `${plugin.source}: README.md is not a file`);
    for (const metadata of [plugin, manifest]) {
      if (metadata.icon !== undefined) {
        assert.equal(typeof metadata.icon, "string", `${plugin.source}: icon must be a local path`);
        assert.ok(statSync(resolve(source, metadata.icon)).isFile(), `${plugin.source}: icon is not a file`);
      }
    }
  });
}

test("every plugin folder is listed exactly once in the marketplace", () => {
  const sources = marketplace.plugins.map((plugin) => resolve(root, plugin.source));
  const folders = readdirSync(join(root, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "plugins", entry.name));
  assert.equal(new Set(sources).size, sources.length, "duplicate marketplace source folders");
  assert.deepEqual(sources.sort(), folders.sort(), "marketplace sources must match the folders in plugins/");
});
