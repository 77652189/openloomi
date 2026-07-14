import {
  type MemorySummaryRecord,
  type RawMessage,
  type RawMessageQuery,
  createRawMessageMemoryGraphStore,
  queryMemoryWithFallback,
  runMemoryForgettingCycle,
  runMemoryGraphCorrection,
  runMemoryGraphRollback,
  runMemoryGraphRolloutEvaluation,
  storeRawMessagesWithGraphEvolution,
} from "@openloomi/indexeddb";
import {
  type OwnerScope,
  buildGraphAwareRetrievalDryRun,
} from "@openloomi/memory-consolidation";
import { describe, expect, it } from "vitest";

const NOW = 1_700_000_000_000;
const OWNER = { userId: "user-1" } satisfies OwnerScope;

class GovernanceRuntimeTestManager {
  readonly messages = new Map<string, RawMessage>();
  readonly summaries = new Map<string, MemorySummaryRecord>();
  nextId = 1;
  failRestoreWrites = 0;
  restoreDeprecatedMessages?: (
    messageIds: string[],
    input: { userId?: string; supersededBySummaryId?: string },
  ) => Promise<number>;

  constructor(input: { supportsRestore?: boolean } = {}) {
    if (input.supportsRestore !== false) {
      this.restoreDeprecatedMessages = async (messageIds, options) => {
        if (this.failRestoreWrites > 0) {
          this.failRestoreWrites -= 1;
          throw new Error("restore write failed");
        }
        let changed = 0;
        for (const messageId of messageIds) {
          const message = this.messages.get(messageId);
          if (
            !message ||
            message.deprecatedAt === undefined ||
            (options.userId && message.userId !== options.userId) ||
            (options.supersededBySummaryId &&
              message.supersededBySummaryId !== options.supersededBySummaryId)
          ) {
            continue;
          }
          const restored = { ...message };
          restored.deprecatedAt = undefined;
          restored.deprecationReason = undefined;
          restored.supersededBySummaryId = undefined;
          this.messages.set(messageId, restored);
          changed += 1;
        }
        return changed;
      };
    }
  }

  async storeMessage(message: RawMessage): Promise<number> {
    const existing = this.messages.get(message.messageId);
    const id = existing?.id ?? this.nextId++;
    this.messages.set(message.messageId, { ...message, id });
    return id;
  }

  async storeMessages(messages: RawMessage[]): Promise<number[]> {
    return Promise.all(messages.map((message) => this.storeMessage(message)));
  }

  async getMessageById(messageId: string): Promise<RawMessage | null> {
    return this.messages.get(messageId) ?? null;
  }

  async queryMessages(query: RawMessageQuery): Promise<RawMessage[]> {
    let messages = [...this.messages.values()];
    if (query.userId) {
      messages = messages.filter((message) => message.userId === query.userId);
    }
    if (!query.includeArchived) {
      messages = messages.filter((message) => message.archivedAt === undefined);
    }
    if (!query.includeDeprecated) {
      messages = messages.filter(
        (message) => message.deprecatedAt === undefined,
      );
    }
    messages.sort((left, right) => right.timestamp - left.timestamp);
    return messages.slice(
      query.offset ?? 0,
      (query.offset ?? 0) + (query.limit ?? query.pageSize ?? messages.length),
    );
  }

  async upsertSummaries(summaries: MemorySummaryRecord[]): Promise<void> {
    for (const summary of summaries) {
      const existing = this.summaries.get(summary.summaryId);
      this.summaries.set(summary.summaryId, {
        ...summary,
        createdAt: existing?.createdAt ?? summary.createdAt,
      });
    }
  }

  async querySummaries(input: {
    userId?: string;
    pageSize?: number;
  }): Promise<MemorySummaryRecord[]> {
    return [...this.summaries.values()]
      .filter((summary) => !input.userId || summary.userId === input.userId)
      .slice(0, input.pageSize);
  }

  async deprecateMessages(
    messageIds: string[],
    input: {
      userId?: string;
      deprecatedAt?: number;
      reason?: string;
      supersededBySummaryId?: string;
    } = {},
  ): Promise<number> {
    let changed = 0;
    for (const messageId of messageIds) {
      const message = this.messages.get(messageId);
      if (
        !message ||
        message.deprecatedAt !== undefined ||
        (input.userId && message.userId !== input.userId)
      ) {
        continue;
      }
      this.messages.set(messageId, {
        ...message,
        deprecatedAt: input.deprecatedAt ?? Date.now(),
        deprecationReason: input.reason,
        supersededBySummaryId: input.supersededBySummaryId,
      });
      changed += 1;
    }
    return changed;
  }

  async searchMessagesSemantically(input: {
    userId: string;
    includeDeprecated?: boolean;
  }): Promise<unknown[]> {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.userId === input.userId &&
          !message.messageId.startsWith("__") &&
          (input.includeDeprecated || message.deprecatedAt === undefined),
      )
      .map((message) => ({ message, similarity: 1 }));
  }

  async hardDeleteArchived(): Promise<number> {
    return 0;
  }

  async markMessagesAccessed(): Promise<number> {
    return 0;
  }
}

function rawMessage(
  messageId: string,
  input: {
    relationValue?: string;
    sourceIdentity?: string;
    applicability?: Record<string, unknown>;
    timestamp?: number;
    userId?: string;
  } = {},
): RawMessage {
  return {
    messageId,
    platform: "slack",
    botId: "bot-1",
    userId: input.userId ?? OWNER.userId,
    timestamp: input.timestamp ?? Math.floor(NOW / 1000),
    content: `User language preference: ${input.relationValue ?? "zh"}`,
    attachments: [],
    metadata: {
      relationGroup: "language",
      relationValue: input.relationValue ?? "zh",
      sourceIdentity: input.sourceIdentity ?? `source:${messageId}`,
      memoryApplicability: input.applicability ?? { scope: "global" },
    },
    embedding: [1, 0],
    embeddingModel: "test",
    createdAt: input.timestamp ?? Math.floor(NOW / 1000),
    memoryStage: "short",
  };
}

async function storeEvidence(
  manager: GovernanceRuntimeTestManager,
  messages: RawMessage[],
  now = NOW,
) {
  return storeRawMessagesWithGraphEvolution({
    storage: manager,
    messages,
    graphEvolution: { enabled: true },
    now,
  });
}

async function graph(
  manager: GovernanceRuntimeTestManager,
  scope: OwnerScope = OWNER,
) {
  return createRawMessageMemoryGraphStore({
    storage: manager,
    ownerScope: scope,
    now: () => NOW,
  }).readSnapshot({ ownerScope: scope, includeAuditOnly: true });
}

async function seedConsolidated(manager: GovernanceRuntimeTestManager) {
  await storeEvidence(manager, [rawMessage("zh-1")]);
  await storeEvidence(
    manager,
    [rawMessage("zh-2", { timestamp: Math.floor(NOW / 1000) + 1 })],
    NOW + 1000,
  );
  await storeEvidence(
    manager,
    [rawMessage("zh-3", { timestamp: Math.floor(NOW / 1000) + 2 })],
    NOW + 2000,
  );
  const lifecycle = await runMemoryForgettingCycle(
    manager as never,
    OWNER.userId,
    { now: NOW + 3000, graphLifecycle: { enabled: true } },
  );
  const summary = [...manager.summaries.values()][0];
  const snapshot = await graph(manager);
  if (!summary || !snapshot.clusters[0]) {
    throw new Error("expected consolidated graph fixture");
  }
  expect(lifecycle.graphLifecycle?.status).toBe("applied");
  return { summary, cluster: snapshot.clusters[0], snapshot };
}

describe("memory graph correction, rollback, and rollout runtime", () => {
  it("corrects an incorrect merge without deleting graph history", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster } = await seedConsolidated(manager);
    manager.failRestoreWrites = 1;
    const partial = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "remove-incorrect-member",
        reason: "The third observation belongs to a separate context",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(partial.status).toBe("partial-failure");
    expect(manager.messages.get("zh-3")?.deprecatedAt).toBeDefined();
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "remove-incorrect-member",
        reason: "The third observation belongs to a separate context",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(result.status).toBe("applied");
    expect(result.restoredRecords).toBe(1);
    expect(manager.messages.get("zh-3")?.deprecatedAt).toBeUndefined();
    const snapshot = await graph(manager);
    expect(
      snapshot.clusters.find((item) => item.clusterId === cluster.clusterId)
        ?.nodeIds,
    ).not.toContain("zh-3");
    expect(
      snapshot.clusters.find((item) => item.nodeIds.includes("zh-3")),
    ).toEqual(
      expect.objectContaining({
        lifecycleStatus: "forming",
        metadata: expect.objectContaining({
          correctedFromClusterId: cluster.clusterId,
        }),
      }),
    );
    expect(
      snapshot.edges.some(
        (edge) =>
          (edge.fromNodeId === "zh-3" || edge.toNodeId === "zh-3") &&
          edge.metadata?.inactive === true,
      ),
    ).toBe(true);
    const operations = await createRawMessageMemoryGraphStore({
      storage: manager,
      ownerScope: OWNER,
    }).readAppliedOperations({ ownerScope: OWNER, nodeId: "zh-3" });
    expect(operations.map((operation) => operation.kind)).toContain(
      "remove-cluster-member",
    );
  });

  it("persists a corrected summary as representative and keeps the old summary audit-only", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "correct-summary-content",
        reason: "The generated summary overstated the preference",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "The user generally prefers Chinese responses.",
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "applied",
        summaryId: expect.any(String),
      }),
    );
    expect(manager.summaries.get(result.summaryId ?? "")?.summaryText).toBe(
      "The user generally prefers Chinese responses.",
    );
    const snapshot = await graph(manager);
    expect(snapshot.clusters[0].representativeNodeId).toBe(result.summaryId);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("audit-only");
    expect(
      snapshot.nodes.find((node) => node.id === result.summaryId)?.visibility,
    ).toBe("default");
    const retrieval = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: snapshot.nodes.map((node) => node.id),
      snapshot,
      visibilityMode: "default",
    });
    expect(retrieval.rankedNodeIds).toContain(result.summaryId);
    expect(retrieval.rankedNodeIds).not.toContain(summary.summaryId);
    expect(result.auditTrail?.sourceNodeIds).toEqual(
      expect.arrayContaining(["zh-1", "zh-2", "zh-3"]),
    );
    const correctionOperations = await createRawMessageMemoryGraphStore({
      storage: manager,
      ownerScope: OWNER,
    }).readAppliedOperations({ ownerScope: OWNER, nodeId: result.summaryId });
    expect(correctionOperations[0]?.metadata).toEqual(
      expect.objectContaining({ previousSummaryText: summary.summaryText }),
    );
  });

  it("applies explicit lifecycle and preferred-representative corrections", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const corrected = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "representative-candidate",
        reason: "Create a reviewed representative",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "Reviewed language preference.",
        },
      },
    });
    const lifecycle = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "mark-cluster-active",
        reason: "Keep this cluster active during review",
        action: {
          type: "set-lifecycle",
          clusterId: cluster.clusterId,
          lifecycleStatus: "active",
        },
      },
    });
    expect(lifecycle.status).toBe("applied");
    expect((await graph(manager)).clusters[0].lifecycleStatus).toBe("active");

    const preferred = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 6000,
      command: {
        commandId: "restore-reviewed-preference",
        reason: "The original summary is the preferred reviewed wording",
        action: {
          type: "set-representative",
          clusterId: cluster.clusterId,
          representativeNodeId: summary.summaryId,
        },
      },
    });
    expect(preferred.status).toBe("applied");
    const snapshot = await graph(manager);
    expect(snapshot.clusters[0].representativeNodeId).toBe(summary.summaryId);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("default");
    expect(
      snapshot.nodes.find((node) => node.id === corrected.summaryId)
        ?.visibility,
    ).toBe("audit-only");
  });

  it("rolls back persisted consolidation, restores raw retrieval, and is idempotent", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary } = await seedConsolidated(manager);
    const first = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "rollback-consolidation",
        reason: "The consolidation must be reversed for review",
        summaryId: summary.summaryId,
      },
    });

    expect(first).toEqual(
      expect.objectContaining({ status: "applied", restoredRecords: 3 }),
    );
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeUndefined();
    }
    const snapshot = await graph(manager);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("audit-only");
    expect(
      snapshot.nodes
        .filter((node) => node.type === "raw")
        .every((node) => node.visibility === "default"),
    ).toBe(true);
    const defaultMemory = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 1,
    });
    expect(defaultMemory.items.every((item) => item.sourceType === "raw")).toBe(
      true,
    );
    const replay = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "rollback-consolidation",
        reason: "The consolidation must be reversed for review",
        summaryId: summary.summaryId,
      },
    });
    expect(["no-op", "replayed"]).toContain(replay.status);
    expect(replay.restoredRecords).toBe(0);
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeUndefined();
  });

  it("keeps the summary active when restore capability is missing or fails", async () => {
    const missing = new GovernanceRuntimeTestManager({
      supportsRestore: false,
    });
    const missingSeed = await seedConsolidated(missing);
    const missingResult = await runMemoryGraphRollback({
      storage: missing,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "rollback-without-adapter",
        reason: "Review rollback",
        summaryId: missingSeed.summary.summaryId,
      },
    });
    expect(missingResult).toEqual(
      expect.objectContaining({
        status: "partial-failure",
        reasonCodes: expect.arrayContaining([
          "adapter_missing_restore_deprecated_messages",
        ]),
      }),
    );
    expect(
      (await graph(missing)).nodes.find(
        (node) => node.id === missingSeed.summary.summaryId,
      )?.visibility,
    ).toBe("default");

    const failing = new GovernanceRuntimeTestManager();
    const failingSeed = await seedConsolidated(failing);
    failing.failRestoreWrites = 1;
    const failed = await runMemoryGraphRollback({
      storage: failing,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "rollback-failing-adapter",
        reason: "Review rollback",
        summaryId: failingSeed.summary.summaryId,
      },
    });
    expect(failed.status).toBe("partial-failure");
    expect(
      (await graph(failing)).nodes.find(
        (node) => node.id === failingSeed.summary.summaryId,
      )?.visibility,
    ).toBe("default");
  });

  it("rejects stale or cross-scope corrections before dependent mutation", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, snapshot } = await seedConsolidated(manager);
    const before = await graph(manager);
    const stale = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stale-correction",
        reason: "stale review",
        expectedVersion: String(Number(snapshot.version ?? "0") - 1),
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(stale.status).toBe("conflict");
    expect(await graph(manager)).toEqual(before);

    const wrongCluster = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "wrong-cluster-correction",
        reason: "wrong cluster",
        action: {
          type: "remove-member",
          clusterId: "missing-cluster",
          nodeId: "zh-3",
        },
      },
    });
    expect(wrongCluster.status).toBe("no-op");
    expect(manager.messages.get("zh-3")?.deprecatedAt).toBeDefined();

    const wrongScope = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "wrong-workspace-correction",
        reason: "wrong workspace",
        workspaceId: "workspace-b",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(wrongScope).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining(["memory_graph_scope_mismatch"]),
      }),
    );
    expect(await graph(manager)).toEqual(before);
  });

  it("exposes competing alternatives and builds rollout decisions from persisted evidence", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "evaluation-correction",
        reason: "Separate a polluted source",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "evaluation-rollback",
        reason: "Restore raw evidence",
        summaryId: summary.summaryId,
      },
    });

    const blocked = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "missing-semantic-artifact",
    });
    expect(blocked.report.summary.decision).toBe("blocked");
    expect(blocked.reasonCodes).toContain(
      "memory_graph_required_semantic_eval_artifact_missing",
    );

    const ready = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "persisted-runtime-artifacts",
      queryEmbedding: [1, 0],
      pollutedArtifactIds: ["zh-3"],
    });
    expect(ready.runtimeEvidence.correctionOperationIds.length).toBeGreaterThan(
      0,
    );
    expect(ready.runtimeEvidence.rollbackOperationIds.length).toBeGreaterThan(
      0,
    );
    expect(ready.report.summary.decision).toBe("ready-for-limited-rollout");
    expect(
      ready.report.graphRetrievalScenarios.find(
        (scenario) => scenario.scenarioId === "runtime-audit-retrieval",
      )?.auditTrailNodeIds,
    ).toContain(summary.summaryId);

    const crossScopeSemantic = rawMessage("cross-scope-semantic");
    crossScopeSemantic.metadata = {
      ...(crossScopeSemantic.metadata ?? {}),
      memoryOwnerScope: {
        userId: OWNER.userId,
        workspaceId: "other-workspace",
      },
    };
    await manager.storeMessage(crossScopeSemantic);
    const contaminated = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "semantic-cross-scope-contamination",
      queryEmbedding: [1, 0],
      pollutedArtifactIds: ["zh-3"],
    });
    expect(contaminated.report.summary.decision).toBe("blocked");
    expect(contaminated.report.semanticRetrievalScenarios[0]?.metadata).toEqual(
      expect.objectContaining({
        crossScopeRecordIds: ["cross-scope-semantic"],
      }),
    );

    const competitionManager = new GovernanceRuntimeTestManager();
    await storeEvidence(competitionManager, [rawMessage("global-zh")]);
    await storeEvidence(
      competitionManager,
      [rawMessage("global-en", { relationValue: "en" })],
      NOW + 1000,
    );
    const competition = await graph(competitionManager);
    const conflict = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: ["global-zh"],
      snapshot: competition,
      visibilityMode: "conflict",
    });
    expect(conflict.reasonCodes).toContain("competing_alternatives_exposed");
    expect(conflict.rankedNodeIds).toEqual(
      expect.arrayContaining(["global-zh", "global-en"]),
    );
  });
});
