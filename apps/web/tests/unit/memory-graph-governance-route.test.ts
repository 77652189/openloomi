import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authMock,
  getRawMessageManagerMock,
  isRawMessageStorageAvailableMock,
  runMemoryGraphCorrectionMock,
  runMemoryGraphRollbackMock,
  runMemoryGraphRolloutEvaluationMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  getRawMessageManagerMock: vi.fn(),
  isRawMessageStorageAvailableMock: vi.fn(),
  runMemoryGraphCorrectionMock: vi.fn(),
  runMemoryGraphRollbackMock: vi.fn(),
  runMemoryGraphRolloutEvaluationMock: vi.fn(),
}));

vi.mock("@/app/(auth)/auth", () => ({ auth: authMock }));
vi.mock("@/lib/memory/raw-message-store", () => ({
  getRawMessageManager: getRawMessageManagerMock,
  getRawMessageStorageBackend: vi.fn(),
  isRawMessageStorageAvailable: isRawMessageStorageAvailableMock,
}));
vi.mock("@openloomi/indexeddb", () => ({
  parseRawMessageGraphEvolutionOptions: vi.fn(),
  parseRawMessageGraphLifecycleOptions: vi.fn(),
  runMemoryGraphCorrection: runMemoryGraphCorrectionMock,
  runMemoryGraphRollback: runMemoryGraphRollbackMock,
  runMemoryGraphRolloutEvaluation: runMemoryGraphRolloutEvaluationMock,
  storeRawMessagesWithGraphEvolution: vi.fn(),
}));
vi.mock("@openloomi/indexeddb/forgetting", () => ({
  queryMemoryWithFallback: vi.fn(),
  runMemoryForgettingCycle: vi.fn(),
}));

import { POST } from "@/app/api/memory/raw-messages/route";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/memory/raw-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as any,
  );
}

describe("memory graph governance route", () => {
  const manager = { id: "raw-manager" };

  beforeEach(() => {
    authMock.mockReset();
    getRawMessageManagerMock.mockReset();
    isRawMessageStorageAvailableMock.mockReset();
    runMemoryGraphCorrectionMock.mockReset();
    runMemoryGraphRollbackMock.mockReset();
    runMemoryGraphRolloutEvaluationMock.mockReset();

    authMock.mockResolvedValue({ user: { id: "authenticated-user" } });
    getRawMessageManagerMock.mockResolvedValue(manager);
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    runMemoryGraphCorrectionMock.mockResolvedValue({ status: "applied" });
    runMemoryGraphRollbackMock.mockResolvedValue({ status: "applied" });
    runMemoryGraphRolloutEvaluationMock.mockResolvedValue({
      report: { summary: { decision: "blocked" } },
    });
  });

  it("binds graph commands and evaluation to the authenticated owner scope", async () => {
    await post({
      action: "graphCorrection",
      command: {
        commandId: "correct-cluster",
        reason: "The source belongs to another context",
        userId: "forged-user",
        workspaceId: "forged-workspace",
        tenantId: "forged-tenant",
        action: {
          type: "set-lifecycle",
          clusterId: "cluster-1",
          lifecycleStatus: "active",
        },
      },
    });
    const correction = runMemoryGraphCorrectionMock.mock.calls[0]?.[0] as {
      command: Record<string, unknown>;
      userId: string;
    };
    expect(correction.userId).toBe("authenticated-user");
    expect(correction.command).not.toHaveProperty("userId");
    expect(correction.command).not.toHaveProperty("workspaceId");
    expect(correction.command).not.toHaveProperty("tenantId");

    await post({
      action: "graphRollback",
      command: {
        commandId: "rollback-summary",
        reason: "Restore raw evidence for review",
        summaryId: "summary-1",
        workspaceId: "forged-workspace",
        tenantId: "forged-tenant",
      },
    });
    const rollback = runMemoryGraphRollbackMock.mock.calls[0]?.[0] as {
      command: Record<string, unknown>;
    };
    expect(rollback.command).not.toHaveProperty("workspaceId");
    expect(rollback.command).not.toHaveProperty("tenantId");

    await post({
      action: "graphRolloutEvaluation",
      options: {
        scenarioId: "cohort-evidence",
        workspaceId: "forged-workspace",
        tenantId: "forged-tenant",
        queryEmbedding: [1, 0, "invalid"],
        pollutedArtifactIds: ["raw-3", 7],
      },
    });
    expect(runMemoryGraphRolloutEvaluationMock).toHaveBeenCalledWith({
      storage: manager,
      userId: "authenticated-user",
      scenarioId: "cohort-evidence",
      workspaceId: undefined,
      tenantId: undefined,
      queryEmbedding: [1, 0],
      pollutedArtifactIds: ["raw-3"],
    });
  });
});
