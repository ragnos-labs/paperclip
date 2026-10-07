// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { OperatorOverview, OperatorWorkItem } from "@paperclipai/shared";
vi.mock("../lib/router", () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }));
const mock = vi.hoisted(() => ({ companyId: "company", connected: false, get: vi.fn(), session: { user: { id: "human" }, session: { id: "session" } } as object | null }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mock.companyId }) }));
vi.mock("../context/LiveUpdatesProvider", () => ({ useOverviewConnection: () => mock.connected }));
vi.mock("../api/operator-overview", () => ({ operatorOverviewApi: { get: mock.get } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => mock.session } }));
import { CompanyOSOverview, OverviewRows } from "./CompanyOSOverview";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
async function render(page: OperatorOverview, stale = false) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(<OverviewRows pages={[page, page]} view={page.view} stale={stale} />));
  return container;
}
const page = (): OperatorOverview => ({ schemaVersion: 1, companyId: "company", view: "work", observedAt: new Date().toISOString(), items: [], hasMore: false, nextOffset: null, liveRuns: [], recentRuns: [], liveRunsTruncated: false, sourceState: { items: "ready", runs: "ready" } });
it("escapes task titles, deduplicates moving pages, and keeps holds/review/acceptance separate", async () => {
  const input = page();
  input.items = [{ companyId: "company", issueId: "issue", identifier: "TASK-1", title: "<script>bad</script>", status: "in_review", priority: "high", humanHold: null, nativeHref: "/issues/issue", updatedAt: new Date().toISOString(), assigneeAgentId: "assigned", executionAgentId: "executor" } as OperatorWorkItem];
  const output = await render(input);
  expect(output.querySelectorAll("script")).toHaveLength(0);
  expect(output.textContent).toContain("<script>bad</script>");
  expect(output.textContent).toContain("1 tasks loaded");
  expect(output.textContent).toContain("Review");
  expect(output.textContent).not.toContain("Waiting for human");
  expect(output.textContent).toContain("assignment differs");
  expect(output.textContent).toContain("do not establish CompanyOS human acceptance");
});
it("keeps completed history out of zero-active output", async () => {
  const input = page();
  input.recentRuns = [{ companyId: "company", runId: "run", agentId: "agent", issueId: null, status: "succeeded", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, currentToolName: null, currentStatusUpdatedAt: null, nativeHref: "/agents/agent/runs/run" }];
  const output = await render(input);
  expect(output.textContent).toContain("No active runs");
  expect(output.querySelector("section")?.textContent).not.toContain("succeeded");
  expect(output.querySelector("details")?.textContent).toContain("succeeded");
});
it("distinguishes unavailable sources and stale liveness from empty success", async () => {
  const input = page(); input.sourceState.runs = "unavailable"; input.sourceState.items = "unavailable";
  const output = await render(input, true);
  expect(output.textContent).toContain("Tasks source unavailable");
  expect(output.textContent).toContain("Run source unavailable. Liveness unknown");
  expect(output.textContent).not.toContain("No active runs");
  expect(output.textContent).not.toContain("No tasks");
});

async function renderPage(client: QueryClient) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={client}><CompanyOSOverview view="work" /></QueryClientProvider>); await new Promise((resolve) => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return container;
}
it("shows disconnect and stale state while preserving last-known rows", async () => {
  const client = new QueryClient(); const input = page();
  mock.get.mockResolvedValue(input); mock.companyId = "company"; mock.session = { user: { id: "human" } };
  const output = await renderPage(client);
  expect(output.textContent).toContain("Updates disconnected");
  client.setQueryData([...queryKeys.operatorOverview("company"), "work", "human"], { pages: [input], pageParams: [0] }, { updatedAt: Date.now() - 70_000 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(output.textContent).toContain("Stale");
  expect(output.textContent).toContain("Liveness unknown");
});
it("clears old company caches and aborts its outstanding request on company switch", async () => {
  const client = new QueryClient(); let signal: AbortSignal | undefined;
  mock.companyId = "old";
  mock.get.mockImplementation((_company: string, _view: string, _offset: number, readSignal: AbortSignal) => { signal = readSignal; return new Promise(() => {}); });
  await renderPage(client);
  const oldSignal = signal;
  mock.companyId = "new"; mock.get.mockResolvedValue({ ...page(), companyId: "new" });
  await act(async () => { root!.render(<QueryClientProvider client={client}><CompanyOSOverview view="work" /></QueryClientProvider>); await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(oldSignal?.aborted).toBe(true);
  expect(client.getQueriesData({ queryKey: queryKeys.operatorOverview("old") })).toEqual([]);
});
it("does not show stale private rows or retry on forbidden responses", async () => {
  const client = new QueryClient(); mock.companyId = "company";
  mock.get.mockReset(); mock.get.mockRejectedValue(new ApiError("Denied", 403, null));
  const input = page(); input.items = [{ issueId: "private", title: "private-title", status: "done", nativeHref: "/issues/private" } as OperatorWorkItem];
  client.setQueryData([...queryKeys.operatorOverview("company"), "work", "human"], { pages: [input], pageParams: [0] });
  const output = await renderPage(client);
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.operatorOverview("company") }); await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(output.textContent).toContain("Access denied");
  expect(output.textContent).not.toContain("private-title");
  expect(mock.get).toHaveBeenCalledTimes(1);
});
it("requires the existing human sign-in and issues no overview read when signed out", async () => {
  mock.session = null; mock.get.mockReset();
  const output = await renderPage(new QueryClient());
  expect(output.textContent).toContain("Human sign-in required");
  expect(mock.get).not.toHaveBeenCalled();
});
