import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Search,
  Settings,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type { Agent, AttentionItem, Issue } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { attentionApi } from "../api/attention";
import { healthApi, type HealthStatus } from "../api/health";
import { issuesApi } from "../api/issues";
import { AgentCapsule } from "../components/AgentCapsule";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { RequestCollapsedSidebar } from "../components/RequestCollapsedSidebar";
import { IssueStatusBadge, StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { timeAgo } from "../lib/timeAgo";

const ACTIVE_ISSUE_STATUSES = new Set(["in_progress"]);
const RECENT_WORK_STATUSES = new Set(["done", "in_review"]);
const DECISION_FIRST_SOURCES = new Set([
  "approval",
  "issue_thread_interaction",
  "join_request",
  "recovery_action",
  "review",
  "budget_alert",
]);

type HermesOrg = {
  role?: string;
  hub?: string;
  accountability_signal?: string;
};

type HermesProfile = {
  profileId?: string;
  label?: string;
  canonicalLifecycle?: string[];
  governanceLifecycle?: string;
  rosterState?: string;
  paperclipMode?: string;
  org?: HermesOrg;
  writePolicy?: { mode?: string };
};

export type ChiefBriefingState = "healthy" | "quiet" | "needs_attention" | "policy_held";

export type ChiefBriefing = {
  agent: Agent;
  department: string;
  summary: string;
  specialistCount: number;
  activeWorkCount: number;
  state: ChiefBriefingState;
  stateDetail: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getHermesProfile(agent: Agent): HermesProfile | null {
  const root = record(agent.metadata)?.ragnosHermes;
  const metadata = record(root);
  if (!metadata || typeof metadata.profileId !== "string") return null;
  return metadata as HermesProfile;
}

export function isManagedHermesAgent(agent: Agent): boolean {
  const profile = getHermesProfile(agent);
  return agent.adapterType === "hermes_gateway" && profile?.rosterState === "live_paused";
}

function departmentLabel(profile: HermesProfile): string {
  const hub = profile.org?.hub;
  const labels: Record<string, string> = {
    engineering: "Engineering",
    marketing: "Marketing",
    money: "Money",
    ops: "Operations",
    personal_assistant: "Personal Assistant",
    rd: "R&D",
    red_team: "Red Team",
    revenue: "Revenue",
    security: "Security",
  };
  return (hub && labels[hub]) || profile.label?.replace(/ Department Rollup$/, "") || "Chief";
}

function chiefSummary(agent: Agent): string {
  const summary = agent.capabilities?.split(" Paperclip is visibility and approval only;")[0]?.trim();
  return summary || "Monitors its governed lane and raises only actionable changes.";
}

function stateForChief(chief: Agent, specialists: Agent[], assignedIssues: Issue[]): Pick<ChiefBriefing, "state" | "stateDetail"> {
  const profile = getHermesProfile(chief);
  const hasAgentError = [chief, ...specialists].some((agent) => agent.status === "error");
  const hasBlockedWork = assignedIssues.some((issue) => issue.status === "blocked");
  if (hasAgentError || hasBlockedWork) {
    return { state: "needs_attention", stateDetail: "Needs attention" };
  }
  if (profile?.governanceLifecycle?.includes("held") || profile?.rosterState === "retired_paused") {
    return { state: "policy_held", stateDetail: "Policy held" };
  }
  if (assignedIssues.some((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status))) {
    return { state: "healthy", stateDetail: "Work moving" };
  }
  return { state: "quiet", stateDetail: "Quiet" };
}

export function buildChiefBriefings(agents: Agent[], issues: Issue[]): ChiefBriefing[] {
  const managed = agents.filter(isManagedHermesAgent);
  const chiefs = managed.filter((agent) => getHermesProfile(agent)?.org?.role === "department_chief");

  return chiefs
    .map((chief) => {
      const specialists = managed.filter((agent) => agent.reportsTo === chief.id);
      const ownedAgentIds = new Set([chief.id, ...specialists.map((agent) => agent.id)]);
      const assignedIssues = issues.filter((issue) =>
        issue.assigneeAgentId != null &&
        ownedAgentIds.has(issue.assigneeAgentId) &&
        !["done", "cancelled"].includes(issue.status));
      return {
        agent: chief,
        department: departmentLabel(getHermesProfile(chief) ?? {}),
        summary: chiefSummary(chief),
        specialistCount: specialists.length,
        activeWorkCount: assignedIssues.filter((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status)).length,
        ...stateForChief(chief, specialists, assignedIssues),
      };
    })
    .sort((left, right) => left.department.localeCompare(right.department));
}

export function selectOperatorAttention(items: AttentionItem[], limit = 3): AttentionItem[] {
  const visible = items.filter((item) => !item.dismissal?.isActive);
  const decisionFirst = visible.filter((item) => DECISION_FIRST_SOURCES.has(item.sourceKind));
  const remaining = visible.filter((item) => !DECISION_FIRST_SOURCES.has(item.sourceKind));
  return [...decisionFirst, ...remaining].slice(0, limit);
}

export function selectWorkInMotion(issues: Issue[], limit = 4): Issue[] {
  return issues
    .filter((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, limit);
}

export function selectRecentWork(issues: Issue[], limit = 5): Issue[] {
  return issues
    .filter((issue) => RECENT_WORK_STATUSES.has(issue.status))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, limit);
}

function chiefStateBadge(state: ChiefBriefingState) {
  if (state === "healthy") return <StatusBadge status="running" label="Healthy" />;
  if (state === "needs_attention") return <StatusBadge status="error" label="Needs attention" />;
  if (state === "policy_held") return <StatusBadge status="paused" label="Policy held" />;
  return <StatusBadge status="idle" label="Quiet" />;
}

function issueHref(issue: Issue): string {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function attentionHref(item: AttentionItem): string {
  return item.subject.href ?? item.relatedIssue?.href ?? "/decisions";
}

export type OperatorBoardViewProps = {
  companyName: string;
  chiefOfStaff: Agent | null;
  chiefBriefings: ChiefBriefing[];
  needsYou: AttentionItem[];
  workInMotion: Issue[];
  recentWork: Issue[];
  movingWorkCount: number;
  hermesProfileCount: number;
  specialistLaneCount: number;
  health: HealthStatus | null;
  onCreateWork?: () => void;
};

export function OperatorBoardView({
  companyName,
  chiefOfStaff,
  chiefBriefings,
  needsYou,
  workInMotion,
  recentWork,
  movingWorkCount,
  hermesProfileCount,
  specialistLaneCount,
  health,
  onCreateWork,
}: OperatorBoardViewProps) {
  const chiefOfStaffName = (chiefOfStaff ? getHermesProfile(chiefOfStaff)?.label : null) ?? chiefOfStaff?.name ?? "Keez";

  return (
    <div className="mx-auto max-w-7xl space-y-8 pb-8" data-testid="operator-board">
      <header className="space-y-6">
        <div className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <AgentCapsule
              state="configured"
              size="sm"
              gradient={9}
              className="mx-0"
              aria-label={`${chiefOfStaffName}, Hermes chief of staff mirror`}
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                {companyName}
              </p>
              <p className="text-sm font-semibold">Operator Board</p>
            </div>
          </div>
          <nav className="grid grid-cols-3 items-center gap-1 sm:flex sm:flex-wrap" aria-label="Operator board navigation">
            <Button asChild size="sm" variant="secondary"><Link to="/board">Home</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to="/issues">Work</Link></Button>
            <Button asChild size="sm" variant="ghost"><a href="#chief-briefings">Chiefs</a></Button>
            <Button asChild size="sm" variant="ghost"><Link to="/search"><Search />Search</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to="/company/settings"><Settings />Settings</Link></Button>
          </nav>
        </div>

        <section className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              Keez company overview
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              See what matters. Skip the control-plane noise.
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
              {chiefOfStaffName} routes visibility across 9 chiefs. Paperclip handles review and approval while Hermes remains the execution authority.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-2xl font-semibold">{chiefBriefings.length}</div>
              <div className="text-xs text-muted-foreground">Chiefs</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-2xl font-semibold">{specialistLaneCount}</div>
              <div className="text-xs text-muted-foreground">Specialists</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-2xl font-semibold">{movingWorkCount}</div>
              <div className="text-xs text-muted-foreground">Moving</div>
            </div>
          </div>
        </section>
      </header>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="gap-0 py-0 shadow-none">
          <CardHeader className="border-b border-border py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4" />
                  Needs You
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">Decisions and reviews that need a human.</p>
              </div>
              <Button asChild size="sm" variant="ghost"><Link to="/decisions">Open all</Link></Button>
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-border px-0">
            {needsYou.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Nothing needs your decision right now.</div>
            ) : needsYou.map((item) => (
              <Link
                key={item.id}
                to={attentionHref(item)}
                className="group flex items-start justify-between gap-4 p-5 text-inherit no-underline transition-colors hover:bg-accent/50"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                    {item.relatedIssue?.identifier ?? item.subject.identifier ?? "Decision"}
                  </p>
                  <p className="mt-1 font-medium leading-5">{item.subject.title ?? item.relatedIssue?.title ?? "Review requested"}</p>
                  <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{item.whyNow}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-foreground">
                  {item.decisionVerbs[0]?.label ?? "Review"}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="gap-0 py-0 shadow-none">
          <CardHeader className="border-b border-border py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CircleDot className="h-4 w-4" />
                  Work In Motion
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">Only work that is actively moving.</p>
              </div>
              {onCreateWork ? <Button size="sm" onClick={onCreateWork}>New work</Button> : null}
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-border px-0">
            {workInMotion.length === 0 ? (
              <div className="p-6">
                <p className="text-sm font-medium">The company is quiet.</p>
                <p className="mt-1 text-sm text-muted-foreground">Start new work when you are ready.</p>
              </div>
            ) : workInMotion.map((issue) => (
              <Link
                key={issue.id}
                to={issueHref(issue)}
                className="flex items-center justify-between gap-4 p-5 text-inherit no-underline transition-colors hover:bg-accent/50"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{issue.identifier ?? "Work"}</p>
                  <p className="mt-1 truncate font-medium">{issue.title}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <IssueStatusBadge status={issue.status} />
                  <span className="hidden text-xs text-muted-foreground sm:inline">{timeAgo(issue.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <section id="chief-briefings" className="scroll-mt-6 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">Hermes organization</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">Chief Briefings</h2>
            <p className="mt-1 text-sm text-muted-foreground">Nine primary lanes, with specialists visible underneath each chief.</p>
          </div>
          <Button asChild size="sm" variant="outline"><Link to="/org"><UsersRound />Full organization</Link></Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {chiefBriefings.map((briefing, index) => (
            <Link
              key={briefing.agent.id}
              to={`/agents/${briefing.agent.urlKey}`}
              className="flex min-h-48 flex-col rounded-xl border border-border bg-card p-5 text-inherit no-underline transition-colors hover:border-foreground/20 hover:bg-accent/30"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <AgentCapsule
                    state="configured"
                    size="sm"
                    gradient={(index % 9) + 1}
                    className="mx-0"
                    aria-label={`${briefing.department} chief mirror`}
                  />
                  <div>
                    <p className="font-semibold">{briefing.department}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {briefing.specialistCount} specialist lane{briefing.specialistCount === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                {chiefStateBadge(briefing.state)}
              </div>
              <p className="mt-4 line-clamp-3 text-sm leading-6 text-muted-foreground">{briefing.summary}</p>
              <div className="mt-auto flex items-center justify-between border-t border-border pt-4 text-xs text-muted-foreground">
                <span>{briefing.activeWorkCount} active work item{briefing.activeWorkCount === 1 ? "" : "s"}</span>
                <span>Preview only</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="border-b border-border py-5">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4" />
              Recent Work
            </CardTitle>
            <Button asChild size="sm" variant="ghost"><Link to="/issues">View work</Link></Button>
          </div>
        </CardHeader>
        <CardContent className="divide-y divide-border px-0">
          {recentWork.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No completed or review-ready work yet.</div>
          ) : recentWork.map((issue) => (
            <Link
              key={issue.id}
              to={issueHref(issue)}
              className="flex flex-col gap-3 p-4 text-inherit no-underline transition-colors hover:bg-accent/50 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <span className="mr-2 text-xs font-medium text-muted-foreground">{issue.identifier ?? "Work"}</span>
                <span className="font-medium">{issue.title}</span>
              </div>
              <IssueStatusBadge status={issue.status} />
              <span className="text-xs text-muted-foreground">{timeAgo(issue.updatedAt)}</span>
            </Link>
          ))}
        </CardContent>
      </Card>

      <section className="grid gap-3 rounded-xl border border-border bg-muted/40 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="System status">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          <div><p className="text-sm font-medium">Paperclip</p><p className="text-xs text-muted-foreground">{health?.status === "ok" ? "Ready" : "Checking"}</p></div>
        </div>
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <div><p className="text-sm font-medium">Hermes</p><p className="text-xs text-muted-foreground">{hermesProfileCount} paused mirrors</p></div>
        </div>
        <div className="flex items-center gap-3">
          <UsersRound className="h-4 w-4 text-muted-foreground" />
          <div><p className="text-sm font-medium">Company shape</p><p className="text-xs text-muted-foreground">9 chiefs, {specialistLaneCount} specialists</p></div>
        </div>
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <div><p className="text-sm font-medium">Control mode</p><p className="text-xs text-muted-foreground">Review only, apply off</p></div>
        </div>
      </section>
    </div>
  );
}

export function OperatorBoard() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();

  useEffect(() => {
    setBreadcrumbs([{ label: "Operator Board" }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 100, sortField: "updated", sortDir: "desc" }),
    enabled: !!selectedCompanyId,
  });
  const attentionQuery = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const issues = useMemo(() => issuesQuery.data ?? [], [issuesQuery.data]);
  const managedHermes = useMemo(() => agents.filter(isManagedHermesAgent), [agents]);
  const chiefBriefings = useMemo(() => buildChiefBriefings(agents, issues), [agents, issues]);
  const chiefOfStaff = managedHermes.find((agent) => getHermesProfile(agent)?.org?.role === "chief_of_staff") ?? null;
  const specialistLaneCount = Math.max(0, managedHermes.length - chiefBriefings.length - (chiefOfStaff ? 1 : 0));

  if (!selectedCompanyId) {
    return <EmptyState icon={UsersRound} message={companies.length === 0 ? "Create a company to use the operator board." : "Select a company to use the operator board."} />;
  }

  if (agentsQuery.isLoading || issuesQuery.isLoading) {
    return <><RequestCollapsedSidebar /><PageSkeleton variant="dashboard" /></>;
  }

  return (
    <>
      <RequestCollapsedSidebar />
      <OperatorBoardView
        companyName={selectedCompany?.name ?? "Company"}
        chiefOfStaff={chiefOfStaff}
        chiefBriefings={chiefBriefings}
        needsYou={selectOperatorAttention(attentionQuery.data?.items ?? [])}
        workInMotion={selectWorkInMotion(issues)}
        recentWork={selectRecentWork(issues)}
        movingWorkCount={issues.filter((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status)).length}
        hermesProfileCount={managedHermes.length}
        specialistLaneCount={specialistLaneCount}
        health={healthQuery.data ?? null}
        onCreateWork={openNewIssue}
      />
    </>
  );
}
