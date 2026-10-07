/** Bounded human-session observation. Native states do not establish acceptance. */
export type OperatorOverviewView = "work" | "team";
export interface OperatorWorkItem {
  companyId: string; issueId: string; identifier: string | null; title: string;
  status: string; priority: string; parentId: string | null; projectId: string | null;
  assigneeAgentId: string | null; assigneeUserId: string | null; updatedAt: string;
  executionAgentId: string | null; executionRunId: string | null; checkoutRunId: string | null;
  humanHold: true | null; nativeHref: string;
}
export interface OperatorTeamItem {
  companyId: string; agentId: string; name: string; role: string; status: string; nativeHref: string;
}
export interface OperatorRun {
  companyId: string; runId: string; issueId: string | null; agentId: string; status: string;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  currentToolName: string | null; currentStatusUpdatedAt: string | null; nativeHref: string;
}
export interface OperatorOverview {
  schemaVersion: 1; companyId: string; view: OperatorOverviewView; observedAt: string;
  items: (OperatorWorkItem | OperatorTeamItem)[]; nextOffset: number | null; hasMore: boolean;
  liveRuns: OperatorRun[]; recentRuns: OperatorRun[]; liveRunsTruncated: boolean;
  sourceState: { items: "ready" | "unavailable"; runs: "ready" | "unavailable" };
}
