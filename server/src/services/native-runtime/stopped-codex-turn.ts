import { parse } from "acorn";
import { canonicalNativeJson } from "./canonical.js";
import { hashToolValue } from "../tool-content-guards.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export interface CompletedTaskControlCall { callId: string; input: unknown }
export interface CompletedMcpReadReceipt {
  invocationId: string;
  toolName: string;
  argumentsHash: string;
  result: unknown;
  receiptHash: string;
}

// Interpret only JSON literals in one completion call. Never evaluate provider
// JavaScript, and never infer safety merely from a script containing a tool name.
function completionScriptInput(source: unknown): unknown {
  if (typeof source !== "string" || source.length > 65536) throw new Error("script unavailable");
  const program = parse(source, { ecmaVersion: 2022, sourceType: "module" }) as unknown as Record<string, unknown>;
  const body = program.body as Record<string, unknown>[];
  if (body.length !== 2) throw new Error("unknown script");
  const first = body[0]!;
  const declarations = first.declarations as Record<string, unknown>[] | undefined;
  if (first.type !== "VariableDeclaration" || first.kind !== "const" || declarations?.length !== 1) throw new Error("unknown declaration");
  const declaration = declarations[0]!;
  const binding = record(declaration.id);
  const awaited = record(declaration.init);
  const call = record(awaited.argument);
  const callee = record(call.callee);
  const output = record(body[1]!.expression);
  const args = call.arguments as unknown[] | undefined;
  const outputArgs = output.arguments as unknown[] | undefined;
  if (binding.type !== "Identifier" || awaited.type !== "AwaitExpression" || call.type !== "CallExpression" ||
      callee.type !== "MemberExpression" || callee.computed || callee.optional || call.optional ||
      record(callee.object).type !== "Identifier" || record(callee.object).name !== "tools" ||
      record(callee.property).name !== "paperclip_finish" || args?.length !== 1 ||
      body[1]!.type !== "ExpressionStatement" || output.type !== "CallExpression" || output.optional ||
      record(output.callee).type !== "Identifier" || record(output.callee).name !== "text" ||
      outputArgs?.length !== 1 || record(outputArgs[0]).type !== "Identifier" || record(outputArgs[0]).name !== binding.name)
    throw new Error("unknown effect");
  let nodes = 0;
  const literal = (value: unknown, depth = 0): unknown => {
    if (++nodes > 4096 || depth > 32) throw new Error("literal too large");
    const node = record(value);
    if (node.type === "Literal" && (node.value === null || ["string", "boolean", "number"].includes(typeof node.value)) && !node.regex && !node.bigint)
      return node.value;
    if (node.type === "ArrayExpression") return (node.elements as unknown[]).map(v => literal(v, depth + 1));
    if (node.type !== "ObjectExpression") throw new Error("nonliteral input");
    const result: Record<string, unknown> = Object.create(null);
    for (const raw of node.properties as unknown[]) {
      const property = record(raw), key = record(property.key);
      const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null;
      if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand ||
          typeof name !== "string" || ["__proto__", "constructor", "prototype"].includes(name) || name in result)
        throw new Error("unknown property");
      result[name] = literal(property.value, depth + 1);
    }
    return result;
  };
  return literal(args[0]);
}

/** A closed, text-only turn can be continued without replaying an unknown action.
 * This is deliberately a closed inventory, not a search for known bad tools.
 * The caller must independently authenticate the session and contain its processes.
 */
export function stoppedCodexTurnIsTextOnly(input: {
  rows: unknown[];
  threadId: string;
  turnId: string;
  cwd: string;
  completedTaskControlCalls?: CompletedTaskControlCall[];
}): boolean {
  const rows = input.rows.map(record);
  const meta = rows[0];
  if (!input.threadId || !input.turnId || meta?.type !== "session_meta" ||
      record(meta.payload).id !== input.threadId || record(meta.payload).cwd !== input.cwd)
    return false;
  const starts = rows.flatMap((row, index) => row.type === "event_msg" &&
    record(row.payload).type === "task_started" && record(row.payload).turn_id === input.turnId
    ? [index] : []);
  if (starts.length !== 1) return false;
  const turn = rows.slice(starts[0]!);
  let contextSeen = false;
  let aborted = false;
  const completedCalls = input.completedTaskControlCalls ?? [];
  const scripts = new Set<string>();
  const seenCalls = new Set<string>();
  const outputs = new Set<string>();
  for (let index = 0; index < turn.length; index++) {
    const row = turn[index]!;
    const payload = record(row.payload);
    if (aborted) return false;
    switch (row.type) {
      case "turn_context":
        if (contextSeen || payload.turn_id !== input.turnId || payload.cwd !== input.cwd) return false;
        contextSeen = true;
        break;
      case "response_item":
        if (payload.type === "custom_tool_call") {
          try {
            if (payload.name !== "exec" || typeof payload.call_id !== "string" || scripts.has(payload.call_id) ||
                !completedCalls.some(call => canonicalNativeJson(call.input) === canonicalNativeJson(completionScriptInput(payload.input)))) return false;
          } catch { return false; }
          scripts.add(payload.call_id as string);
          break;
        }
        if (payload.type === "custom_tool_call_output") {
          if (typeof payload.call_id !== "string" || !scripts.has(payload.call_id) || outputs.has(payload.call_id)) return false;
          outputs.add(payload.call_id);
          break;
        }
        if (!["message", "reasoning"].includes(String(payload.type))) return false;
        break;
      case "world_state":
      case "token_usage_record":
        break;
      case "event_msg":
        switch (payload.type) {
          case "task_started":
            if (index !== 0 || payload.turn_id !== input.turnId) return false;
            break;
          case "turn_aborted":
            if (payload.turn_id !== input.turnId || payload.reason !== "interrupted") return false;
            aborted = true;
            break;
          case "token_count":
            break;
          case "item_completed":
            if (payload.thread_id !== input.threadId || payload.turn_id !== input.turnId) return false;
            if (record(payload.item).type === "DynamicToolCall") {
              const item = record(payload.item);
              if (item.tool !== "paperclip_finish" || item.status !== "completed" || item.success !== true ||
                  typeof item.id !== "string" || seenCalls.has(item.id) ||
                  !completedCalls.some(call => call.callId === item.id && canonicalNativeJson(call.input) === canonicalNativeJson(item.arguments))) return false;
              seenCalls.add(item.id);
            } else if (!["AgentMessage", "UserMessage", "Reasoning"].includes(String(record(payload.item).type))) return false;
            break;
          default: return false;
        }
        break;
      default: return false;
    }
  }
  return contextSeen && aborted && scripts.size === outputs.size && scripts.size === completedCalls.length && seenCalls.size === completedCalls.length;
}

/** An additive closed inventory. The caller authenticates every server receipt
 * and its frozen target; provider hints and tool names grant no authority. */
export function stoppedCodexTurnReadCalls(input: Parameters<typeof stoppedCodexTurnIsTextOnly>[0] & {
  completedMcpReads: CompletedMcpReadReceipt[];
}): { callId: string; invocationId: string; toolName: string; argumentsHash: string }[] | null {
  try {
    const receipts = new Map(input.completedMcpReads.map(receipt => [receipt.invocationId, receipt]));
    if (!receipts.size || receipts.size > 512 || receipts.size !== input.completedMcpReads.length) return null;
    const rows = input.rows.map(record);
    const start = rows.findIndex(row => row.type === "event_msg" &&
      record(row.payload).type === "task_started" && record(row.payload).turn_id === input.turnId);
    if (start < 0) return null;
    const calls = new Map<string, { toolName: string; argumentsHash: string }>();
    const outputs = new Map<string, string>();
    const completed = new Map<string, string>();
    const used = new Set<string>();
    let aborted = false;
    const retained = rows.filter((row, index) => {
      if (index < start) return true;
      const payload = record(row.payload);
      if (aborted) return true;
      if (row.type === "event_msg" && payload.type === "turn_aborted") {
        aborted = true;
        return true;
      }
      if (row.type === "response_item" && payload.type === "function_call") {
        if (typeof payload.call_id !== "string" || calls.has(payload.call_id) ||
            typeof payload.name !== "string" || !payload.name.startsWith("mcp__paperclip_assigned__") ||
            typeof payload.arguments !== "string") throw new Error("unsupported call");
        calls.set(payload.call_id, { toolName: payload.name.slice("mcp__paperclip_assigned__".length),
          argumentsHash: hashToolValue(JSON.parse(payload.arguments)) });
        return false;
      }
      if (row.type === "response_item" && payload.type === "function_call_output") {
        const call = typeof payload.call_id === "string" ? calls.get(payload.call_id) : undefined;
        if (!call || outputs.has(payload.call_id as string) || typeof payload.output !== "string") throw new Error("unbound output");
        const result = JSON.parse(payload.output);
        const meta = record(record(result)._meta);
        const bridge = record(meta["paperclip.dev/invocationReceipt"]);
        const receipt = typeof bridge.invocationId === "string" ? receipts.get(bridge.invocationId) : undefined;
        if (bridge.schema !== "paperclip.mcp_invocation_receipt.v1" || !receipt || used.has(receipt.invocationId) ||
            receipt.toolName !== call.toolName || receipt.argumentsHash !== call.argumentsHash ||
            canonicalNativeJson(receipt.result) !== canonicalNativeJson(result)) throw new Error("unverified output");
        outputs.set(payload.call_id as string, receipt.invocationId);
        used.add(receipt.invocationId);
        return false;
      }
      if (row.type === "event_msg" && payload.type === "item_completed" && record(payload.item).type === "McpToolCall") {
        const item = record(payload.item);
        const call = typeof item.id === "string" ? calls.get(item.id) : undefined;
        if (!call || completed.has(item.id as string) || item.server !== "paperclip-assigned" ||
            item.tool !== call.toolName || item.status !== "completed" || item.error != null ||
            record(item.result).isError !== false || payload.thread_id !== input.threadId || payload.turn_id !== input.turnId ||
            hashToolValue(item.arguments) !== call.argumentsHash) throw new Error("unverified completed item");
        const bridge = record(record(record(item.result)._meta)["paperclip.dev/invocationReceipt"]);
        const receipt = typeof bridge.invocationId === "string" ? receipts.get(bridge.invocationId) : undefined;
        if (!receipt || receipt.argumentsHash !== call.argumentsHash || receipt.toolName !== call.toolName ||
            canonicalNativeJson(item.result) !== canonicalNativeJson(receipt.result)) throw new Error("unverified completed result");
        completed.set(item.id as string, receipt.invocationId);
        return false;
      }
      return true;
    });
    if (calls.size !== receipts.size || calls.size !== completed.size || calls.size !== outputs.size ||
      ![...outputs].every(([callId, invocationId]) => completed.get(callId) === invocationId) ||
      used.size !== receipts.size || !stoppedCodexTurnIsTextOnly({ ...input, rows: retained })) return null;
    return [...outputs].map(([callId, invocationId]) => ({ callId, invocationId, ...calls.get(callId)! }));
  } catch { return null; }
}
