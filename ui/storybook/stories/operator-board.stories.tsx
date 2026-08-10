import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, AttentionItem, Issue } from "@paperclipai/shared";
import { OperatorBoardView, type ChiefBriefing } from "@/pages/OperatorBoard";

const now = new Date("2026-08-10T14:00:00Z");

function chiefAgent(index: number, department: string): Agent {
  const profileId = `${department.toLowerCase().replaceAll("&", "and").replaceAll(" ", "_")}_department_rollup`;
  return {
    id: `chief-${index}`,
    companyId: "company-storybook",
    name: `Hermes | ${department} Department Rollup`,
    urlKey: profileId,
    role: "general",
    title: `${department} chief`,
    icon: null,
    status: "paused",
    reportsTo: "keez",
    capabilities: `${department} keeps its governed lane visible and raises only actionable exceptions.`,
    adapterType: "hermes_gateway",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: now,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: {
      ragnosHermes: {
        profileId,
        label: `${department} Department Rollup`,
        rosterState: "live_paused",
        governanceLifecycle: "active_advisory",
        org: { role: "department_chief", hub: department.toLowerCase() },
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function issue(id: string, title: string, status: Issue["status"], minutesAgo: number): Issue {
  return {
    id,
    companyId: "company-storybook",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: Number(id),
    identifier: `RAG-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: status === "in_progress" ? now : null,
    completedAt: status === "done" ? now : null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: new Date(now.getTime() - minutesAgo * 60_000),
  };
}

function attention(id: string, identifier: string, title: string, whyNow: string): AttentionItem {
  const timestamp = now.toISOString();
  return {
    id,
    companyId: "company-storybook",
    sourceKind: "review",
    subject: {
      kind: "issue",
      id: `issue-${id}`,
      companyId: "company-storybook",
      title,
      identifier,
      status: "in_review",
      href: `/RAG/issues/${identifier}`,
    },
    whyNow,
    decisionVerbs: [{ id: "review", label: "Review", description: null }],
    inlineResolvable: false,
    entryRule: "review requested",
    exitRule: "review completed",
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

const departments = [
  ["Engineering", 11],
  ["Marketing", 0],
  ["Money", 2],
  ["Operations", 7],
  ["Personal Assistant", 0],
  ["R&D", 2],
  ["Red Team", 0],
  ["Revenue", 2],
  ["Security", 2],
] as const;

const chiefs: ChiefBriefing[] = departments.map(([department, specialistCount], index) => ({
  agent: chiefAgent(index, department),
  department,
  summary: `${department} keeps its governed lane visible and raises only actionable exceptions.`,
  specialistCount,
  activeWorkCount: index === 0 ? 1 : 0,
  state: index === 0 ? "healthy" : "quiet",
  stateDetail: index === 0 ? "Work moving" : "Quiet",
}));

const keez = {
  ...chiefAgent(10, "Keez"),
  id: "keez",
  name: "Hermes | Keez Request Router",
  metadata: {
    ragnosHermes: {
      profileId: "keez_request_router",
      label: "Keez Request Router",
      rosterState: "live_paused",
      governanceLifecycle: "active_advisory",
      org: { role: "chief_of_staff", hub: "keez" },
    },
  },
} satisfies Agent;

function OperatorBoardStory() {
  return (
    <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <OperatorBoardView
        companyName="RAGnos"
        chiefOfStaff={keez}
        chiefBriefings={chiefs}
        needsYou={[
          attention("1", "RAG-41", "Review the local proposal fixture", "A safe diff is ready for a human decision."),
          attention("2", "RAG-37", "Confirm the next governed work item", "Keez needs an explicit priority before routing."),
        ]}
        workInMotion={[
          issue("44", "Finish the local Paperclip operator board", "in_progress", 6),
        ]}
        recentWork={[
          issue("43", "Wire the Hermes roster into Paperclip", "done", 18),
          issue("42", "Repair the Fleet proposal handoff", "in_review", 34),
          issue("40", "Store the local administrator login", "done", 51),
        ]}
        movingWorkCount={1}
        hermesProfileCount={37}
        specialistLaneCount={27}
        health={{ status: "ok", deploymentMode: "authenticated", deploymentExposure: "private" }}
        onCreateWork={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: "RAGnos/Operator Board",
  component: OperatorBoardStory,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "A stripped-down company board that keeps decisions, moving work, nine chiefs, recent work, and truthful paused Hermes visibility in one scan.",
      },
    },
  },
} satisfies Meta<typeof OperatorBoardStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
