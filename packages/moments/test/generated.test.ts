import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script without type declarations.
import { FORBIDDEN, findForbidden } from "../../../scripts/sync-from-monorepo.mjs";

const generated = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "generated");
const files = readdirSync(generated).filter((f) => f.endsWith(".ts"));

describe("generated files", () => {
  it("exist", () => {
    expect(files.sort()).toEqual(["browserDiagnostics.ts", "drawStrokes.ts", "keyMomentsCursorContext.ts", "keyMomentsFusion.ts", "localMomentPlan.ts", "types.ts"]);
  });

  it.each(files)("%s carries the license header and no comments beyond it", (name) => {
    // Normalize line endings so the test passes on Windows (CRLF) and Unix (LF).
    const lines = readFileSync(join(generated, name), "utf8").replace(/\r\n/g, "\n").split("\n");
    expect(lines[0]).toBe("// SPDX-License-Identifier: Apache-2.0");
    expect(lines[1]).toMatch(/^\/\/ GENERATED from lib\//);
    // The printer puts any comment on its own line; none survive past the header.
    expect(lines.slice(2).filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l))).toEqual([]);
  });

  it.each(files)("%s contains no internal terms", (name) => {
    expect(findForbidden(readFileSync(join(generated, name), "utf8"))).toEqual([]);
  });
});

describe("the internal-terms guard", () => {
  it("catches each term in any case, in code or in a string", () => {
    for (const term of FORBIDDEN as string[]) {
      expect(findForbidden(`const note = "see ${term.toUpperCase()} for why";`)).toHaveLength(1);
    }
    expect(findForbidden("export const ok = 'clean';")).toEqual([]);
  });
});
