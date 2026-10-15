import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  reject: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
  listReviewAttention: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { errorHandler, approvalRoutes };
});

function createApp() {
  const { errorHandler, approvalRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "hunter",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function rejected(payload: Record<string, unknown>) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "rejected",
    payload,
    decisionNote: "The summary misses the Q3 numbers",
    requestedByAgentId: null,
  };
}

describe("internal build sign-off rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockIssueService.update.mockResolvedValue({});
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-done", companyId: "company-1", status: "done", assigneeAgentId: "worker" },
      { id: "issue-open", companyId: "company-1", status: "in_progress", assigneeAgentId: "worker" },
    ]);
  });

  it("reopens the closed task and wakes its assignee with the rejection note", async () => {
    const approval = rejected({ kind: "internal_build_signoff" });
    mockApprovalService.getById.mockResolvedValue({ ...approval, status: "pending" });
    mockApprovalService.reject.mockResolvedValue({ approval, applied: true });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({ decisionNote: "The summary misses the Q3 numbers" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-done", {
      status: "todo",
      actorUserId: "hunter",
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "worker",
      expect.objectContaining({
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "issue-done",
          decisionNote: "The summary misses the Q3 numbers",
          wakeReason: "internal_build_signoff_rejected",
        }),
      }),
    );
  });

  it("leaves tasks alone when an ordinary approval is rejected", async () => {
    const approval = rejected({ title: "Approve hosting spend" });
    mockApprovalService.getById.mockResolvedValue({ ...approval, status: "pending" });
    mockApprovalService.reject.mockResolvedValue({ approval, applied: true });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({ decisionNote: "not now" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
