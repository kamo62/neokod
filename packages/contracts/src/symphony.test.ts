import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ApprovalRequestSchema, RunAttemptSchema, WorkItemSchema } from "./symphony.ts";

const decodeWorkItem = Schema.decodeUnknownSync(WorkItemSchema);
const decodeApprovalRequest = Schema.decodeUnknownSync(ApprovalRequestSchema);
const decodeRunAttempt = Schema.decodeUnknownSync(RunAttemptSchema);

const workItem = {
  id: "work-item-1",
  mode: "symphony",
  objective: "Verify process identity",
  acceptanceCriteria: [],
  source: { kind: "manual" },
  lifecycle: "running",
  eligibilityReasons: [],
  evidence: null,
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-08T10:00:00.000Z",
} as const;

describe("WorkItemSchema process identity", () => {
  it("accepts a positive matching process identity tuple", () => {
    expect(
      decodeWorkItem({
        ...workItem,
        ownerPid: 42,
        ownerPgid: 42,
      }),
    ).toMatchObject({ ownerPid: 42, ownerPgid: 42 });
  });

  it.each([
    ["zero", { ownerPid: 0, ownerPgid: 0 }],
    ["negative", { ownerPid: -42, ownerPgid: -42 }],
    ["missing ownerPid", { ownerPgid: 42 }],
    ["mismatched ownerPid", { ownerPid: 41, ownerPgid: 42 }],
  ])("rejects a %s process identity tuple", (_name, identity) => {
    expect(() => decodeWorkItem({ ...workItem, ...identity })).toThrow();
  });

  it.each([
    ["absent", {}],
    ["unspawned", { ownerPid: null, ownerPgid: null }],
    ["unsupported group signalling", { ownerPid: 42, ownerPgid: null }],
  ])("accepts %s group signalling metadata", (_name, identity) => {
    expect(() => decodeWorkItem({ ...workItem, ...identity })).not.toThrow();
  });
});

const approvalRequest = {
  id: "sym-1",
  requestId: "req-1",
  workItemId: "work-item-1",
  action: "command_execution",
  scope: "once",
  state: "pending",
  affectedFiles: [],
  createdAt: "2026-08-08T10:00:00.000Z",
  decidedAt: null,
} as const;

describe("ApprovalRequestSchema request kind", () => {
  it("decodes a payload written before the request kind existed", () => {
    // Pre-kind payloads only carry the action. They are evidence, so they must
    // decode rather than be rejected; the consumer derives the kind.
    const decoded = decodeApprovalRequest(approvalRequest);
    expect(decoded.kind).toBeUndefined();
    expect(decoded.action).toBe("command_execution");
  });

  it("decodes a pre-kind user-input payload", () => {
    const decoded = decodeApprovalRequest({ ...approvalRequest, action: "user_input" });
    expect(decoded.kind).toBeUndefined();
    expect(decoded.action).toBe("user_input");
  });

  it("keeps an explicit request kind", () => {
    expect(decodeApprovalRequest({ ...approvalRequest, kind: "user_input" }).kind).toBe(
      "user_input",
    );
  });

  it("accepts an interrupted decision", () => {
    expect(
      decodeApprovalRequest({
        ...approvalRequest,
        kind: "approval",
        state: "interrupted",
        decision: "interrupted",
      }).decision,
    ).toBe("interrupted");
  });
});

describe("ApprovalRequestSchema question payload and answer history", () => {
  const questionPayload = {
    kind: "structured",
    version: 1,
    questions: [
      {
        id: "q1",
        header: "Branch",
        question: "Which branch?",
        options: [
          { label: "main", description: "default branch" },
          { label: "release", description: "release branch" },
        ],
      },
      {
        id: "q2",
        header: "Checks",
        question: "Which checks should run?",
        options: [
          { label: "unit", description: "unit tests" },
          { label: "lint", description: "lint" },
        ],
        multiSelect: true,
        sensitive: false,
      },
    ],
  } as const;

  it("round-trips structured questions with options and multi-select", () => {
    const decoded = decodeApprovalRequest({
      ...approvalRequest,
      kind: "user_input",
      action: "user_input",
      state: "answered",
      decision: "answered",
      questionPayload,
      answer: {
        answers: [
          { questionId: "q1", answer: "main" },
          { questionId: "q2", answer: ["unit", "lint"] },
        ],
        delivery: "unknown",
        actor: "local_operator",
        recordedAt: "2026-08-08T10:00:05.000Z",
      },
    });
    expect(decoded.questionPayload).toMatchObject({ kind: "structured", version: 1 });
    if (decoded.questionPayload?.kind !== "structured") throw new Error("expected structured");
    expect(decoded.questionPayload.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
    expect(decoded.questionPayload.questions[1]?.multiSelect).toBe(true);
    expect(decoded.answer?.answers).toEqual([
      { questionId: "q1", answer: "main" },
      { questionId: "q2", answer: ["unit", "lint"] },
    ]);
  });

  it("decodes a legacy free-text question without inventing choices", () => {
    const decoded = decodeApprovalRequest({
      ...approvalRequest,
      kind: "user_input",
      action: "user_input",
      questionPayload: { kind: "legacy_text", text: "Which branch?" },
      answer: {
        answers: [],
        legacyText: "main",
        delivery: "unknown",
        actor: "local_operator",
        recordedAt: "2026-08-08T10:00:05.000Z",
      },
    });
    expect(decoded.questionPayload).toEqual({ kind: "legacy_text", text: "Which branch?" });
    expect(decoded.answer?.legacyText).toBe("main");
  });

  it("keeps an unsupported question payload explicit", () => {
    expect(
      decodeApprovalRequest({
        ...approvalRequest,
        kind: "user_input",
        action: "user_input",
        questionPayload: {
          kind: "unsupported",
          providerMethod: "item/tool/requestUserInput",
          detail: "missing question id",
        },
      }).questionPayload,
    ).toEqual({
      kind: "unsupported",
      providerMethod: "item/tool/requestUserInput",
      detail: "missing question id",
    });
  });

  it("rejects a structured payload with an unknown version", () => {
    expect(() =>
      decodeApprovalRequest({
        ...approvalRequest,
        questionPayload: { ...questionPayload, version: 2 },
      }),
    ).toThrow();
  });

  it("decodes a history-only decision note", () => {
    expect(
      decodeApprovalRequest({
        ...approvalRequest,
        decisionNote: {
          text: "Approved for this run only",
          delivery: "history_only",
          actor: "local_operator",
          recordedAt: "2026-08-08T10:00:05.000Z",
        },
      }).decisionNote?.delivery,
    ).toBe("history_only");
  });
});

const runAttempt = {
  id: "run-1",
  workItemId: "work-item-1",
  attemptNumber: 1,
  workspacePath: "/repo",
  provider: { instanceId: "codex_default", driver: "codex" },
  status: "streaming_turn",
  startedAt: "2026-08-08T10:00:00.000Z",
  finishedAt: null,
  error: null,
} as const;

const acceptedGuidance = {
  schemaVersion: 1,
  acceptedAt: "2026-08-08T10:00:00.000Z",
  digest: "sha256:abc",
  workflow: {
    id: "workflow-1",
    path: "/repo/WORKFLOW.md",
    revision: "2026-08-08T09:00:00.000Z",
    digest: "sha256:workflow",
    instructions: "Implement the issue.",
    validationRequired: [],
  },
  source: {
    trackerId: "github:owner/repo",
    kind: "github",
    identifier: "#1",
    title: "Issue 1",
    description: null,
    acceptanceCriteria: [],
    labels: ["agent-ready"],
    revision: null,
    digest: "sha256:source",
  },
  guidance: {
    batch: { state: "absent" },
    story: { state: "present", text: "" },
    digest: "sha256:guidance",
  },
  target: {
    repositoryPath: "/repo",
    workflowPath: "/repo/WORKFLOW.md",
    provider: { instanceId: "codex_default", driver: "codex" },
  },
  permission: {
    autonomy: "execute",
    approvalPolicy: "on-request",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite" },
    editsAllowed: true,
    approvalsEnabled: true,
    protectedPaths: [],
    delivery: {
      approvalBeforePush: null,
      approvalBeforePullRequest: true,
      approvalBeforeMerge: null,
    },
  },
} as const;

describe("RunAttemptSchema accepted guidance", () => {
  it("keeps legacy attempts without an invented snapshot", () => {
    expect(decodeRunAttempt(runAttempt).acceptedGuidance).toBeUndefined();
  });

  it("round-trips a frozen accepted snapshot and keeps absent versus empty guidance distinct", () => {
    const decoded = decodeRunAttempt({ ...runAttempt, acceptedGuidance });
    expect(decoded.acceptedGuidance).toEqual(acceptedGuidance);
    expect(decoded.acceptedGuidance?.guidance.batch.state).toBe("absent");
    expect(decoded.acceptedGuidance?.guidance.story).toEqual({ state: "present", text: "" });
    expect(decoded.acceptedGuidance?.permission.delivery.approvalBeforePush).toBeNull();
  });

  it("preserves a manual work source instead of relabelling it as a tracker", () => {
    const decoded = decodeRunAttempt({
      ...runAttempt,
      acceptedGuidance: {
        ...acceptedGuidance,
        source: {
          ...acceptedGuidance.source,
          trackerId: "manual:item-1",
          kind: "manual",
        },
      },
    });
    expect(decoded.acceptedGuidance?.source.kind).toBe("manual");
  });
});

describe("ApprovalRequestSchema question payload robustness", () => {
  it("accepts an empty option description while keeping the label", () => {
    const decoded = decodeApprovalRequest({
      ...approvalRequest,
      kind: "user_input",
      action: "user_input",
      questionPayload: {
        kind: "structured",
        version: 1,
        questions: [
          {
            id: "q1",
            header: "Branch",
            question: "Which branch?",
            options: [{ label: "main", description: "" }],
          },
        ],
      },
    });
    if (decoded.questionPayload?.kind !== "structured") {
      throw new Error("expected structured");
    }
    expect(decoded.questionPayload.questions[0]?.options).toEqual([
      { label: "main", description: "" },
    ]);
  });

  it("decodes a staged delivery state", () => {
    expect(
      decodeApprovalRequest({
        ...approvalRequest,
        kind: "user_input",
        action: "user_input",
        state: "delivering",
        decision: "answered",
      }).state,
    ).toBe("delivering");
  });
});

describe("AcceptedSourceSnapshot manual source", () => {
  it("preserves a manual work source instead of relabelling it as a tracker", () => {
    const decoded = decodeRunAttempt({
      ...runAttempt,
      acceptedGuidance: {
        ...acceptedGuidance,
        source: {
          ...acceptedGuidance.source,
          trackerId: "manual:item-1",
          kind: "manual",
        },
      },
    });
    expect(decoded.acceptedGuidance?.source.kind).toBe("manual");
  });
});
