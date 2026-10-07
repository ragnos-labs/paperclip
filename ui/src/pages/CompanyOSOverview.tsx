import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorOverview, OperatorOverviewView, OperatorRun, OperatorTeamItem, OperatorWorkItem } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { operatorOverviewApi } from "../api/operator-overview";
import { ApiError } from "../api/client";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useOverviewConnection } from "../context/LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "../components/ui/button";
import { relativeTime } from "../lib/utils";

const taskStates: Record<string, string> = { backlog: "Planned", todo: "Planned", in_progress: "In progress", in_review: "Review", done: "Done", blocked: "Blocked", cancelled: "Cancelled" };
const runStates = new Set(["queued", "scheduled_retry", "running", "succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
const agentStates = new Set(["active", "paused", "idle", "running", "error", "pending_approval", "terminated"]);
const label = (value: string, known: Set<string>) => known.has(value) ? value.replaceAll("_", " ") : `Unknown (${value})`;

function RunRows({ runs, stale }: { runs: OperatorRun[]; stale: boolean }) {
  return <ul className="flex flex-col gap-2">{runs.map((run) => <li key={run.runId} className="flex flex-wrap items-center gap-2 break-all">
    <Link to={run.nativeHref} className="underline" disableIssueQuicklook>Run {run.runId.slice(0, 8)}</Link>
    <span>{stale ? "Liveness unknown" : label(run.status, runStates)}</span>
    {run.issueId && <Link to={`/issues/${run.issueId}`} className="underline" disableIssueQuicklook>Task</Link>}
    <span className="text-muted-foreground">Executing as {run.agentId.slice(0, 8)}</span>
    <span>{!stale && run.currentToolName && run.currentStatusUpdatedAt && Date.now() - Date.parse(run.currentStatusUpdatedAt) <= 90_000 ? run.currentToolName : "Current step unknown"}</span>
  </li>)}</ul>;
}

export function OverviewRows({ pages, view, stale }: { pages: OperatorOverview[]; view: OperatorOverviewView; stale: boolean }) {
  const seen = new Set<string>();
  const items = pages.flatMap((page) => page.items).filter((item) => {
    const id = "issueId" in item ? item.issueId : item.agentId;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  const latest = pages[0];
  const runs = latest?.liveRuns ?? [];
  return <>
    <p className="text-muted-foreground">{items.length} {view === "work" ? "tasks" : "agents"} loaded. This is a bounded view; tasks may move between pages.</p>
    {pages.some((page) => page.sourceState.items !== "ready") ? <p role="alert">{view === "work" ? "Tasks" : "Roster"} source unavailable.</p> : items.length === 0 && <p>No {view === "work" ? "tasks" : "agents"} in this view.</p>}
    <ul className="flex flex-col gap-3">{items.map((item) => {
      if (view === "work") {
        const task = item as OperatorWorkItem;
        const taskRuns = runs.filter((run) => run.issueId === task.issueId);
        return <li key={task.issueId} className="border border-border rounded-lg p-3 flex flex-col gap-2 min-w-0 break-words">
          <div className="flex flex-wrap gap-2"><Link to={task.nativeHref} className="underline" disableIssueQuicklook>{task.identifier ?? "Task"}: {task.title}</Link><span>{taskStates[task.status] ?? `Unknown (${task.status})`}</span><span>{task.priority}</span></div>
          <p>Assigned to {task.assigneeAgentId ? `agent ${task.assigneeAgentId.slice(0, 8)}` : task.assigneeUserId ? "human" : "unassigned"}{task.humanHold && <span> · Waiting for human</span>}</p>
          <p className="text-muted-foreground">Updated {relativeTime(task.updatedAt)}</p>
          <RunRows runs={taskRuns} stale={stale || latest.sourceState.runs !== "ready"} />
          {task.executionAgentId && task.executionAgentId !== task.assigneeAgentId && <p>Executing as {task.executionAgentId.slice(0, 8)}; assignment differs.</p>}
        </li>;
      }
      const agent = item as OperatorTeamItem;
      const active = runs.filter((run) => run.agentId === agent.agentId);
      return <li key={agent.agentId} className="border border-border rounded-lg p-3 flex flex-col gap-2 min-w-0 break-words">
        <Link to={agent.nativeHref} className="underline">{agent.name}</Link><p>{agent.role} · {label(agent.status, agentStates)}</p>
        <RunRows runs={active} stale={stale || latest.sourceState.runs !== "ready"} />
        {agent.status === "running" && active.length === 0 && <p>Agent says running; no active run is linked in this bounded view.</p>}
      </li>;
    })}</ul>
    <section className="flex flex-col gap-2"><h2 className="text-lg font-semibold">Active runs</h2>
      {latest?.sourceState.runs !== "ready" ? <p role="alert">Run source unavailable. Liveness unknown.</p> : <>
        {!stale && runs.length === 0 && <p>No active runs.</p>}
        {stale && <p>Liveness unknown; last-known runs follow.</p>}
        {latest.liveRunsTruncated && <p>50 shown; more may exist.</p>}
        <RunRows runs={runs} stale={stale} />
      </>}
    </section>
    <details><summary>Recent 50 runs</summary><RunRows runs={latest?.recentRuns ?? []} stale={stale || latest?.sourceState.runs !== "ready"} /></details>
    <p className="text-muted-foreground">Native Done and successful runs do not establish CompanyOS human acceptance.</p>
  </>;
}

export function CompanyOSOverview({ view }: { view: OperatorOverviewView }) {
  const { selectedCompanyId } = useCompany();
  const client = useQueryClient();
  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
  const connected = useOverviewConnection(selectedCompanyId);
  const scope = `${selectedCompanyId}:${session?.user.id}`;
  const [deniedScope, setDeniedScope] = useState<string | null>(null);
  useEffect(() => setDeniedScope(null), [scope]);
  const [now, setNow] = useState(Date.now());
  const prefix = queryKeys.operatorOverview(selectedCompanyId ?? "");
  const query = useInfiniteQuery({
    queryKey: [...prefix, view, session?.user.id ?? "signed-out"],
    queryFn: ({ pageParam, signal }) => operatorOverviewApi.get(selectedCompanyId!, view, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: !!selectedCompanyId && !!session && deniedScope !== scope,
    staleTime: 15_000, gcTime: 0,
    refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true, refetchOnReconnect: true,
    retry: (count, error) => count < 2 && (!(error instanceof ApiError) || error.status >= 500 || error.status === 429),
    retryDelay: (attempt, error) => error instanceof ApiError && error.status === 429 ? error.retryAfterMs ?? 30_000 : Math.min(1000 * 2 ** attempt, 15_000),
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => {
    void client.cancelQueries({ queryKey: queryKeys.operatorOverview(selectedCompanyId ?? "") });
    client.removeQueries({ queryKey: queryKeys.operatorOverview(selectedCompanyId ?? "") });
  }, [client, selectedCompanyId, session?.user.id]);
  const denied = deniedScope === scope || (query.error instanceof ApiError && [401, 403].includes(query.error.status));
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) client.setQueryData(queryKeys.auth.session, null);
    if (query.error instanceof ApiError && query.error.status === 403) setDeniedScope(scope);
  }, [client, query.error, scope]);
  useEffect(() => {
    if (deniedScope !== scope) return;
    void client.cancelQueries({ queryKey: prefix });
    client.removeQueries({ queryKey: prefix });
  }, [client, deniedScope, scope, selectedCompanyId]);
  if (!session) return <p>Human sign-in required. <Link to="/auth" className="underline">Sign in</Link></p>;
  if (!selectedCompanyId) return <p>Select a company.</p>;
  if (denied) return <p role="alert">Access denied. Select a company you can access or sign in again.</p>;
  const pages = query.data?.pages.filter((page) => page.companyId === selectedCompanyId && page.view === view) ?? [];
  const stale = query.isError || now - query.dataUpdatedAt > 60_000;
  return <div className="flex flex-col gap-4 min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold">{view === "work" ? "Work" : "Team"}</h1><Button onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh</Button></div>
    <p role="status" aria-live="polite">{connected ? "Updates connected" : "Updates disconnected"} · {query.isFetching ? "Refreshing" : pages.length ? `${stale ? "Stale" : "Observed"} ${relativeTime(new Date(query.dataUpdatedAt).toISOString())}` : "Waiting for source"}</p>
    {query.isError && <p role="alert">Overview unavailable. {pages.length > 0 && "Showing last-known rows."}</p>}
    {pages.length > 0 && <OverviewRows pages={pages} view={view} stale={stale} />}
    {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetching}>Load more</Button>}
  </div>;
}
