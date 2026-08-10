import { describe, expect, it } from "vitest";
import type { Agent, AttentionItem, Issue } from "@paperclipai/shared";
import {
  buildChiefBriefings,
  selectOperatorAttention,
  selectRecentWork,
  selectWorkInMotion,
} from "./OperatorBoard";

function makeAgent(input: {
  id: string;
  profileId: string;
  label: string;
  role: string;
  hub: string;
  reportsTo?: string | null;
  status?: Agent["status"];
}): Agent {
  return {
    id: input.id,
    companyId: "company-1",
    name: `Hermes | ${input.label}`,
    urlKey: input.profileId,
    role: "general",
    title: input.label,
    icon: null,
    status: input.status ?? "paused",
    reportsTo: input.reportsTo ?? null,
    capabilities: `${input.label} keeps its lane accountable. Paperclip is visibility and approval only; Hermes remains execution authority.`,
    adapterType: "hermes_gateway",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: {
      ragnosHermes: {
        profileId: input.profileId,
        label: input.label,
        rosterState: "live_paused",
        governanceLifecycle: "active_advisory",
        org: { role: input.role, hub: input.hub },
      },
    },
    createdAt: new Date("2026-08-10T10:00:00Z"),
    updatedAt: new Date("2026-08-10T10:00:00Z"),
  };
}

function makeIssue(id: string, status: Issue["status"], updatedAt: string, assigneeAgentId: string | null = null): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Work ${id}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    assigneeAgentId,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: `RAG-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-08-10T09:00:00Z"),
    updatedAt: new Date(updatedAt),
  };
}

function makeAttention(id: string, sourceKind: AttentionItem["sourceKind"]): AttentionItem {
  const timestamp = "2026-08-10T10:00:00Z";
  return {
    id,
    companyId: "company-1",
    sourceKind,
    subject: {
      kind: "issue",
      id: `subject-${id}`,
      companyId: "company-1",
      title: `Decision ${id}`,
      identifier: `RAG-${id}`,
      status: "pending",
      href: `/RAG/issues/RAG-${id}`,
    },
    whyNow: "A human decision is required.",
    decisionVerbs: [{ id: "review", label: "Review", description: null }],
    inlineResolvable: false,
    entryRule: "pending",
    exitRule: "resolved",
    dedupKey: id,
    dismissalKey: id,
    dismissal: null,
    severity: "medium",
    rank: 1,
    activityAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    relatedIssue: null,
    project: null,
    workspace: null,
    detail: null,
    trainingExampleId: null,
  };
}

describe("OperatorBoard model", () => {
  it("builds chief briefings from the canonical Hermes reporting links", () => {
    const engineering = makeAgent({
      id: "chief-engineering",
      profileId: "engineering_department_rollup",
      label: "Engineering Department Rollup",
      role: "department_chief",
      hub: "engineering",
    });
    const security = makeAgent({
      id: "chief-security",
      profileId: "security_department_rollup",
      label: "Security Department Rollup",
      role: "department_chief",
      hub: "security",
    });
    const monitor = makeAgent({
      id: "monitor-1",
      profileId: "observability_stack_heartbeat",
      label: "Observability Stack Heartbeat",
      role: "monitor",
      hub: "engineering",
      reportsTo: engineering.id,
    });
    const blocked = makeIssue("4", "blocked", "2026-08-10T11:00:00Z", monitor.id);

    const briefings = buildChiefBriefings([engineering, security, monitor], [blocked]);

    expect(briefings.map((briefing) => briefing.department)).toEqual(["Engineering", "Security"]);
    expect(briefings[0]).toMatchObject({ specialistCount: 1, state: "needs_attention" });
    expect(briefings[1]).toMatchObject({ specialistCount: 0, state: "quiet" });
  });

  it("puts direct decisions ahead of diagnostic failures", () => {
    const selected = selectOperatorAttention([
      makeAttention("failure", "failed_run"),
      makeAttention("review", "review"),
      makeAttention("approval", "approval"),
    ], 2);

    expect(selected.map((item) => item.id)).toEqual(["review", "approval"]);
  });

  it("keeps active work and recent completed work as separate views", () => {
    const issues = [
      makeIssue("1", "in_progress", "2026-08-10T11:00:00Z"),
      makeIssue("2", "done", "2026-08-10T12:00:00Z"),
      makeIssue("3", "in_review", "2026-08-10T13:00:00Z"),
      makeIssue("4", "blocked", "2026-08-10T14:00:00Z"),
    ];

    expect(selectWorkInMotion(issues).map((issue) => issue.id)).toEqual(["1"]);
    expect(selectRecentWork(issues).map((issue) => issue.id)).toEqual(["3", "2"]);
  });
});
