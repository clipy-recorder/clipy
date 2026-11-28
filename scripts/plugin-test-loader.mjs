/**
 * Custom Node.js module resolution hook for plugin helper tests.
 *
 * Solves two problems the production .ts files have when loaded by Node:
 * 1. Extensionless relative imports (./signin instead of ./signin.ts) —
 *    standard in TypeScript but not in Node ESM.
 * 2. The claude-code runtime import in register.tsx — stubbed with the
 *    three symbols the pure helpers' module scope needs (atom, read, update).
 */
import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  // Stub claude-code: provide no-op exports for the runtime symbols.
  if (specifier === "claude-code") {
    return {
      url: "claude-code-stub:",
      shortCircuit: true,
    };
  }

  // Resolve extensionless relative imports to .ts files.
  if (
    specifier.startsWith("./") &&
    !specifier.endsWith(".ts") &&
    !specifier.endsWith(".tsx") &&
    !specifier.endsWith(".js") &&
    !specifier.endsWith(".mjs") &&
    context.parentURL
  ) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    for (const ext of [".ts", ".tsx"]) {
      const candidate = join(parentDir, specifier + ext);
      try {
        await stat(candidate);
        return nextResolve(pathToFileURL(candidate).href, context);
      } catch {
        // not found, try next
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Provide a stub module for claude-code runtime imports.
  if (url === "claude-code-stub:") {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export function atom() { return {} }
        export function read() { return undefined }
        export function update() {}
      `,
    };
  }

  return nextLoad(url, context);
}
