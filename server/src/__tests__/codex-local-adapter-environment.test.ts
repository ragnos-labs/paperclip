import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-codex-local/server";

const itWindows = process.platform === "win32" ? it : it.skip;

describe("codex_local environment diagnostics", () => {
  it("adds --skip-git-repo-check to the hello probe by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-probe-"));
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const capturePath = path.join(root, "capture.json");
    const fakeCodex = path.join(binDir, "codex");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2) }), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");
      await fs.chmod(fakeCodex, 0o755);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[] };
      expect(capture.argv).toContain("--skip-git-repo-check");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-codex-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "codex_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  itWindows("runs the hello probe when Codex is available via a Windows .cmd wrapper", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex.cmd");
    const script = [
      "@echo off",
      "echo {\"type\":\"thread.started\",\"thread_id\":\"test-thread\"}",
      "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
      "echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      "exit /b 0",
      "",
    ].join("\r\n");

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate --skip-git-repo-check when extraArgs already include it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-probe-existing-"));
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const capturePath = path.join(root, "capture.json");
    const fakeCodex = path.join(binDir, "codex");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2) }), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");
      await fs.chmod(fakeCodex, 0o755);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          extraArgs: ["--skip-git-repo-check"],
          env: {
            OPENAI_API_KEY: "test-key",
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[] };
      expect(capture.argv.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
