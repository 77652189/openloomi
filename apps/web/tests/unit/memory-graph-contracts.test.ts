import { describe, expect, it } from "vitest";
import type {
  ClusterLifecyclePolicy,
  GraphAwareRetriever,
  GraphEvolutionReport,
  GraphInteractionEngine,
  MemoryConsolidationPlanner,
  MemoryGraphStore,
  MemoryGraphUpdatePlan,
  OwnerScope,
} from "@openloomi/memory-consolidation";

const NOW = 1_700_000_000_000;

const ownerScope = {
  userId: "user-1",
  workspaceId: "workspace-1",
  tenantId: "tenant-1",
} satisfies OwnerScope;

const rawNode = {
  id: "node:raw:1",
  ownerScope,
  type: "raw",
  sourceId: "record-1",
  createdAt: NOW,
  visibility: "default",
  metadata: {
    topic: "answer-language",
  },
} satisfies MemoryGraphUpdatePlan["candidateNodes"][number];

const summaryNode = {
  id: "node:summary:1",
  ownerScope,
  type: "summary",
  sourceId: "summary-1",
  createdAt: NOW + 1,
  visibility: "default",
} satisfies MemoryGraphUpdatePlan["candidateNodes"][number];

const supportEdge = {
  id: "edge:raw-1:summary-1",
  ownerScope,
  fromNodeId: rawNode.id,
  toNodeId: summaryNode.id,
  kind: "supersede",
  weight: 1,
  confidence: 0.92,
  evidenceNodeIds: [rawNode.id],
  reasonCodes: ["summary_sedimentation"],
  createdAt: NOW + 1,
} satisfies MemoryGraphUpdatePlan["candidateEdges"][number];

describe("memory graph interface contracts", () => {
  it("keeps dry-run graph interaction scoped and persistence-explicit", async () => {
    const interactionEngine: GraphInteractionEngine = {
      async planInteraction(input) {
        return {
          ownerScope: input.ownerScope,
          candidateNodes: [rawNode, summaryNode],
          candidateEdges: [supportEdge],
          operations: [
            {
              operationId: "op:create-supersede-edge",
              ownerScope: input.ownerScope,
              kind: "create-edge",
              nodeIds: [rawNode.id, summaryNode.id],
              edgeIds: [supportEdge.id],
              reasonCodes: ["summary_sedimentation"],
            },
          ],
          persistence: {
            mode: "dry-run",
            enabled: false,
          },
          reasonCodes: ["graph_interaction_dry_run"],
        };
      },
    };

    const plan = await interactionEngine.planInteraction({
      ownerScope,
      newNodes: [rawNode],
      candidateSnapshot: {
        ownerScope,
        nodes: [rawNode],
        edges: [],
        clusters: [],
        capturedAt: NOW,
      },
      now: NOW,
    });

    expect(plan.ownerScope).toEqual(ownerScope);
    expect(plan.persistence).toEqual({
      mode: "dry-run",
      enabled: false,
    });
    expect(plan.operations).toEqual([
      expect.objectContaining({
        ownerScope,
        kind: "create-edge",
        reasonCodes: ["summary_sedimentation"],
      }),
    ]);
  });

  it("separates store persistence, lifecycle, consolidation, retrieval, and audit boundaries", async () => {
    const snapshot = {
      ownerScope,
      nodes: [rawNode, summaryNode],
      edges: [supportEdge],
      clusters: [
        {
          clusterId: "cluster:language",
          ownerScope,
          nodeIds: [rawNode.id, summaryNode.id],
          lifecycleStatus: "stable",
          representativeNodeId: summaryNode.id,
          supportScore: 0.92,
          updatedAt: NOW + 1,
          reasonCodes: ["stable_support"],
        },
      ],
      capturedAt: NOW + 1,
    } satisfies Awaited<ReturnType<MemoryGraphStore["readSnapshot"]>>;

    const graphStore: MemoryGraphStore = {
      async readSnapshot(query) {
        expect(query.ownerScope).toEqual(ownerScope);
        return snapshot;
      },
      async persistPlan(plan) {
        return {
          ownerScope: plan.ownerScope,
          appliedOperations: [],
          skippedOperations: plan.operations.map((operation) => ({
            operation,
            reasonCodes: ["adapter_noop"],
          })),
          mutatesGraph: false,
          diagnostics: ["adapter_noop"],
        };
      },
      async readAuditTrail(query) {
        expect(query.includeDeprecated).toBe(true);
        return {
          ownerScope: query.ownerScope,
          nodeId: query.nodeId,
          sourceNodeIds: [rawNode.id],
          edgeIds: [supportEdge.id],
          operationIds: ["op:create-supersede-edge"],
          reasonCodes: ["audit_trail_available"],
        };
      },
    };
    const lifecyclePolicy: ClusterLifecyclePolicy = {
      async evaluate(input) {
        return {
          ownerScope: input.ownerScope,
          transitions: [
            {
              ownerScope: input.ownerScope,
              clusterId: "cluster:language",
              fromStatus: "active",
              toStatus: "stable",
              representativeNodeId: summaryNode.id,
              reasonCodes: ["stable_support"],
            },
          ],
          consolidationEligibleClusterIds: ["cluster:language"],
          auditOnlyClusterIds: [],
          reasonCodes: ["cluster_lifecycle_evaluated"],
        };
      },
    };
    const consolidationPlanner: MemoryConsolidationPlanner = {
      async plan(input) {
        return {
          ownerScope: input.ownerScope,
          summaryCandidates: [
            {
              candidateId: "candidate:summary:language",
              ownerScope: input.ownerScope,
              clusterId: "cluster:language",
              sourceNodeIds: [rawNode.id],
              representativeNodeId: summaryNode.id,
              reasonCodes: ["stable_cluster_summary_candidate"],
            },
          ],
          deprecationPlans: [
            {
              ownerScope: input.ownerScope,
              sourceNodeIds: [rawNode.id],
              supersededByNodeId: summaryNode.id,
              reasonCodes: ["superseded_by_summary"],
            },
          ],
          archiveCandidateNodeIds: [],
          preserveClusterIds: [],
          reasonCodes: ["consolidation_plan_created"],
        };
      },
    };
    const retriever: GraphAwareRetriever = {
      async compare(input) {
        return {
          ownerScope: input.ownerScope,
          rankedNodeIds: [summaryNode.id],
          hiddenDeprecatedNodeIds: [rawNode.id],
          expandedClusterIds: ["cluster:language"],
          auditTrail:
            input.visibilityMode === "audit"
              ? [
                  await graphStore.readAuditTrail({
                    ownerScope: input.ownerScope,
                    nodeId: summaryNode.id,
                    includeDeprecated: input.includeDeprecated,
                  }),
                ]
              : undefined,
          reasonCodes: ["summary_preferred_over_deprecated_source"],
        };
      },
    };

    const graphSnapshot = await graphStore.readSnapshot({ ownerScope });
    const lifecycle = await lifecyclePolicy.evaluate({
      ownerScope,
      snapshot: graphSnapshot,
      now: NOW + 1,
    });
    const consolidationPlan = await consolidationPlanner.plan({
      ownerScope,
      snapshot: graphSnapshot,
      lifecycle,
      now: NOW + 1,
    });
    const persistenceResult = await graphStore.persistPlan({
      ownerScope,
      candidateNodes: [],
      candidateEdges: [],
      operations: [
        {
          operationId: "op:set-stable",
          ownerScope,
          kind: "set-cluster-lifecycle",
          nodeIds: [rawNode.id, summaryNode.id],
          clusterId: "cluster:language",
          fromStatus: "active",
          toStatus: "stable",
          reasonCodes: ["stable_support"],
        },
      ],
      persistence: {
        mode: "write",
        enabled: true,
      },
      reasonCodes: ["opt_in_persistence_requested"],
    });
    const retrieval = await retriever.compare({
      ownerScope,
      query: "language preference",
      baselineNodeIds: [rawNode.id, summaryNode.id],
      snapshot: graphSnapshot,
      visibilityMode: "audit",
      includeDeprecated: true,
    });
    const report = {
      reportId: "report:phase-1-contracts",
      generatedAt: NOW + 2,
      ownerScope,
      summary: {
        ownerScope,
        dryRun: false,
        mutatesGraph: persistenceResult.mutatesGraph,
        mutatesStorage: false,
        mutatesRuntime: false,
        mutatesRetrieval: false,
        operationCount: 1,
        warningCount: 1,
      },
      persistenceResult,
      lifecycleResult: lifecycle,
      consolidationPlan,
      retrievalResult: retrieval,
      warnings: ["adapter_noop"],
      reasonCodes: ["phase_1_contract_boundaries"],
    } satisfies GraphEvolutionReport;

    expect(lifecycle.transitions[0]).toEqual(
      expect.objectContaining({
        ownerScope,
        fromStatus: "active",
        toStatus: "stable",
      }),
    );
    expect(consolidationPlan.deprecationPlans[0]).toEqual(
      expect.objectContaining({
        ownerScope,
        sourceNodeIds: [rawNode.id],
        supersededByNodeId: summaryNode.id,
      }),
    );
    expect(persistenceResult).toEqual(
      expect.objectContaining({
        ownerScope,
        mutatesGraph: false,
        diagnostics: ["adapter_noop"],
      }),
    );
    expect(retrieval).toEqual(
      expect.objectContaining({
        ownerScope,
        rankedNodeIds: [summaryNode.id],
        hiddenDeprecatedNodeIds: [rawNode.id],
        auditTrail: [
          expect.objectContaining({
            ownerScope,
            sourceNodeIds: [rawNode.id],
          }),
        ],
      }),
    );
    expect(report.summary).toEqual(
      expect.objectContaining({
        ownerScope,
        mutatesStorage: false,
        mutatesRuntime: false,
        mutatesRetrieval: false,
      }),
    );
  });
});
