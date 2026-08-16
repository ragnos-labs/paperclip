#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const operationalFailure = /credential|authoriz|token endpoint|authenticat|unauthorized|denied|forbidden|timeout|timed out|tls|certificate|connection|network|dial tcp|rate limit|too many requests|parse|unexpected/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyRegistryInspect({ reference, status, output }) {
  if (!reference || typeof reference !== "string") throw new Error("registry reference is required");
  if (status === 0) throw new Error("registry reference already exists");
  if (status !== 1) throw new Error(`registry inspection failed with unexpected status ${String(status)}`);
  if (typeof output !== "string" || output.trim() === "") {
    throw new Error("registry inspection returned no absence evidence");
  }
  if (operationalFailure.test(output)) {
    throw new Error("registry inspection had an operational or authorization failure");
  }

  try {
    const response = JSON.parse(output);
    const errors = response?.errors;
    if (
      Array.isArray(errors)
      && errors.length > 0
      && errors.every((error) => ["MANIFEST_UNKNOWN", "NAME_UNKNOWN"].includes(error?.code))
    ) {
      return "absent";
    }
  } catch {
    // Docker normally emits text. Structured registry errors are handled above.
  }

  const escapedReference = escapeRegExp(reference);
  const exactNotFound = new RegExp(`^ERROR:\\s+${escapedReference}:\\s+not found\\s*$`, "i");
  const targetManifestUnknown = new RegExp(`${escapedReference}[^\\n]*(?:manifest unknown|name unknown)`, "i");
  if (exactNotFound.test(output.trim()) || targetManifestUnknown.test(output)) return "absent";

  throw new Error("registry inspection did not prove the target reference is absent");
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const reference = readArgument("--reference");
  const rawStatus = readArgument("--status");
  const status = rawStatus && /^\d+$/.test(rawStatus) ? Number(rawStatus) : Number.NaN;
  const output = readFileSync(0, "utf8");
  classifyRegistryInspect({ reference, status, output });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[registry-reference-guard] ${error.message}`);
    process.exit(1);
  }
}
