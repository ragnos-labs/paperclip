import { describe, expect, it } from "vitest";
import { stoppedCodexTurnIsTextOnly, stoppedCodexTurnReadCalls } from "./stopped-codex-turn.js";
import { hashToolValue, namedGatewayToolResult } from "../tool-content-guards.js";
const meta = { type: "session_meta", payload: { id: "thread", cwd: "/workspace" } };
const start = { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } };
const context = { type: "turn_context", payload: { turn_id: "turn", cwd: "/workspace" } };
const answer = { type: "response_item", payload: { type: "message", role: "assistant" } };
const stop = { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn", reason: "interrupted" } };
const check = (rows: unknown[]) => stoppedCodexTurnIsTextOnly({ rows, threadId: "thread", turnId: "turn", cwd: "/workspace" });
describe("stopped Codex turn inventory", () => {
  it("accepts an exactly bound, closed text-only turn", () => {
    expect(check([meta, start, context, answer, stop])).toBe(true);
  });
  it("does not treat partial output or an unrelated abort as containment", () => {
    expect(check([meta, start, context, answer])).toBe(false);
    expect(check([meta, start, context, { ...stop, payload: { ...stop.payload, turn_id: "other" } }])).toBe(false);
  });
  it.each(["function_call", "custom_tool_call", "web_search_call", "unknown_future_action"])("refuses unverified %s outcomes", type => {
    expect(check([meta, start, context, { type: "response_item", payload: { type } }, stop])).toBe(false);
  });
  it("refuses later work, duplicate starts, and changed session identity", () => {
    expect(check([meta, start, context, stop, answer])).toBe(false);
    expect(check([meta, start, context, start, stop])).toBe(false);
    expect(check([{ ...meta, payload: { ...meta.payload, id: "other" } }, start, context, stop])).toBe(false);
  });
  it("does not replay completed actions in earlier turns", () => {
    expect(check([meta, { type: "response_item", payload: { type: "custom_tool_call" } }, start, context, answer, stop])).toBe(true);
  });
  const completed = { callId: "finish-id", input: { summary: "ready" } };
  const completionRows = (source: string) => [meta, start, context,
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "script", input: source } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: "turn",
      item: { type: "DynamicToolCall", tool: "paperclip_finish", id: completed.callId, arguments: completed.input, status: "completed", success: true } } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "script", output: [] } }, answer, stop];
  const checkCompletion = (source: string, calls = [completed]) => stoppedCodexTurnIsTextOnly({
    rows: completionRows(source), threadId: "thread", turnId: "turn", cwd: "/workspace", completedTaskControlCalls: calls,
  });
  it("preserves completion bookkeeping with an exact accepted receipt", () => {
    expect(checkCompletion('const r = await tools.paperclip_finish({summary: "ready"}); text(r);')).toBe(true);
    expect(checkCompletion('const r = await tools.paperclip_finish({summary: "ready"}); text(r);', [])).toBe(false);
    expect(checkCompletion('const r = await tools.paperclip_finish({summary: "different"}); text(r);')).toBe(false);
  });
  it.each([
    'await tools.send_email({}); const r = await tools.paperclip_finish({summary: "ready"}); text(r);',
    'const r = await tools.paperclip_finish({summary: tools.write_file()}); text(r);',
    'const r = await tools.paperclip_finish({get summary() { return "ready"; }}); text(r);',
    'const r = await tools.paperclip_finish({...external, summary: "ready"}); text(r);',
    'const r = await tools.paperclip_finish({summary: `ready`}); text(r);',
    'const r = await tools["paperclip_finish"]({summary: "ready"}); text(r);',
    'const r = await tools.paperclip_finish({summary: "ready"}); tools.send_email(r);',
    'const r = await tools.paperclip_finish({__proto__: {summary: "ready"}}); text(r);',
  ])("refuses unverified execution hidden in completion code %s", source => {
    expect(checkCompletion(source)).toBe(false);
  });
});

describe("stopped Codex read-turn inventory", () => {
  const result = namedGatewayToolResult({ invocationId: "receipt", result: {
    content: "read result", data: { content: [], isError: false, transport: "mcp_http", spawnedLocalProcess: false },
  } });
  const receipt = { invocationId: "receipt", toolName: "archive_read", argumentsHash: hashToolValue({ query: "current" }),
    result, receiptHash: "a".repeat(64) };
  const call = { type: "response_item", payload: { type: "function_call", name: "mcp__paperclip_assigned__archive_read",
    call_id: "call", arguments: JSON.stringify({ query: "current" }) } };
  const output = { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: JSON.stringify(result) } };
  const item = { type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: "turn",
    item: { type: "McpToolCall", id: "call", server: "paperclip-assigned", tool: "archive_read",
      arguments: { query: "current" }, status: "completed", error: null, result } } };
  const rows = [meta, start, context, call, item, output, answer, stop];
  const verify = (candidate = rows, receipts = [receipt]) => stoppedCodexTurnReadCalls({
    rows: candidate, threadId: "thread", turnId: "turn", cwd: "/workspace", completedMcpReads: receipts,
  });
  it("requires a one-to-one exact server receipt for a completed read in a closed turn", () => {
    expect(verify()).toEqual([{ callId: "call", invocationId: "receipt", toolName: receipt.toolName, argumentsHash: receipt.argumentsHash }]);
    expect(check(rows)).toBe(false); // Existing text-only contract remains unchanged.
    expect(verify(rows, [])).toBeNull();
    expect(verify(rows, [receipt, receipt])).toBeNull();
  });
  it.each(["missing output", "missing completion", "incomplete turn", "duplicate call", "duplicate output", "work after stop",
    "wrong tool", "wrong input", "wrong session", "wrong turn", "provider error", "wrong receipt", "changed result", "unknown action"])(
    "holds %s", (failure) => {
      const candidate = structuredClone(rows);
      const c = candidate[3]!.payload as Record<string, unknown>;
      const completion = candidate[4]!.payload as Record<string, unknown>;
      const i = completion.item as Record<string, unknown>;
      const o = candidate[5]!.payload as Record<string, unknown>;
      switch (failure) {
        case "missing output": candidate.splice(5, 1); break;
        case "missing completion": candidate.splice(4, 1); break;
        case "incomplete turn": candidate.pop(); break;
        case "duplicate call": candidate.splice(4, 0, structuredClone(call)); break;
        case "duplicate output": candidate.splice(6, 0, structuredClone(output)); break;
        case "work after stop": candidate.push(structuredClone(call)); break;
        case "wrong tool": c.name = "mcp__other__archive_read"; break;
        case "wrong input": c.arguments = '{"query":"different"}'; break;
        case "wrong session": completion.thread_id = "other"; break;
        case "wrong turn": completion.turn_id = "other"; break;
        case "provider error": i.error = { message: "failed" }; break;
        case "wrong receipt": o.output = JSON.stringify({ ...result, _meta: {} }); break;
        case "changed result": o.output = JSON.stringify({ ...result, content: [] }); break;
        case "unknown action": candidate.splice(6, 0, { type: "response_item", payload: { type: "custom_tool_call" } } as typeof call); break;
      }
      expect(verify(candidate)).toBeNull();
    },
  );
});
