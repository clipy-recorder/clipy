#!/usr/bin/env node
/**
 * Generates `packages/config/config.schema.json` from `storedConfigSchema` via
 * Zod 4's `z.toJSONSchema`. Compiles `src/schema.ts` into a temporary directory
 * inside the package so this script works on Node 20.19+ even before a build.
 *
 * Pass `--check` to exit non-zero if `config.schema.json` is missing or stale.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const outFile = join(pkgDir, "config.schema.json");
const checkOnly = process.argv.includes("--check");

const tsc = createRequire(join(pkgDir, "package.json")).resolve("typescript/bin/tsc");
const tmpDir = mkdtempSync(join(pkgDir, ".schema-build-"));

try {
  execFileSync(
    process.execPath,
    [
      tsc,
      "--outDir",
      tmpDir,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--skipLibCheck",
      join(pkgDir, "src", "schema.ts"),
    ],
    { stdio: "inherit" },
  );

  const { buildConfigJsonSchema } = await import(pathToFileURL(join(tmpDir, "schema.js")).href);
  const expected = `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;

  if (checkOnly) {
    const current = existsSync(outFile) ? readFileSync(outFile, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== expected) {
      process.stderr.write(
        "config.schema.json is missing or out of date. Run: pnpm --filter @clipy/local-config run schema\n",
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outFile, expected, "utf8");
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
