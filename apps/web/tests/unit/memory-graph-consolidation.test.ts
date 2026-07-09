import { describe, expect, it } from "vitest";
import {
  buildMemoryGraphConsolidationPlan,
  buildMemoryGraphDeprecationEntries,
  createMemoryGraphConsolidationPlanner,
  type ClusterLifecyclePolicyResult,
  type MemoryGraphClusterSnapshot,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
  type OwnerScope,
} from "@openloomi/memory-consolidation";

const NOW = 1_700_000_000_000;

const ownerScope = {
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  userId: "user-1",
} satisfies OwnerScope;

const otherOwnerScope = {
  tenantId: "tenant-1",
  workspaceId: "workspace-2",
  userId: "user-2",
} satisfies OwnerScope;

function node(
  id: string,
  type: MemoryGraphNode["type"] = "raw",
  scope: OwnerScope = ownerScope,
): MemoryGraphNode {
  return {
    id,
    ownerScope: scope,
    type,
    visibility: "default",
    createdAt: NOW - 1,
  };
}

function cluster(
  clusterId: string,
  nodeIds: string[],
  lifecycleStatus: MemoryGraphClusterSnapshot["lifecycleStatus"],
  options: {
    representativeNodeId?: string;
    supportScore?: number;
    scope?: OwnerScope;
  } = {},
): MemoryGraphClusterSnapshot {
  return {
    clusterId,
    ownerScope: options.scope ?? ownerScope,
    nodeIds,
    lifecycleStatus,
    representativeNodeId: options.representativeNodeId,
    supportScore: options.supportScore,
    updatedAt: NOW,
    reasonCodes: [`${lifecycleStatus}_fixture`],
    metadata: {
      competitionKey: `${clusterId}:competition`,
    },
  };
}

function supersedeEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
): MemoryGraphEdge {
  return {
    id,
    ownerScope,
    fromNodeId,
    toNodeId,
    kind: "supersede",
    weight: 1,
    evidenceNodeIds: [fromNodeId],
    reasonCodes: ["summary_sedimentation"],
    createdAt: NOW,
  };
}

function lifecycle(): ClusterLifecyclePolicyResult {
  return {
    ownerScope,
    transitions: [
      {
        ownerScope,
        clusterId: "cluster:superseded",
        fromStatus: "stable",
        toStatus: "superseded",
        representativeNodeId: "node:summary:superseded",
        reasonCodes: ["supersede_relation_observed"],
      },
      {
        ownerScope,
        clusterId: "cluster:decaying",
        fromStatus: "active",
        toStatus: "decaying",
        reasonCodes: ["stale_or_unsupported_cluster"],
      },
    ],
    consolidationEligibleClusterIds: ["cluster:stable"],
    auditOnlyClusterIds: [],
    reasonCodes: ["cluster_lifecycle_dry_run"],
  };
}

function snapshot(): MemoryGraphSnapshot {
  const stableA = node("node:raw:stable-a");
  const stableB = node("node:raw:stable-b");
  const supersededRaw = node("node:raw:superseded");
  const supersededSummary = node("node:summary:superseded", "summary");
  const decayingRaw = node("node:raw:decaying");
  const activeRaw = node("node:raw:active");
  const foreignRaw = node("node:raw:foreign", "raw", otherOwnerScope);

  return {
    ownerScope,
    nodes: [
      stableA,
      stableB,
      supersededRaw,
      supersededSummary,
      decayingRaw,
      activeRaw,
      foreignRaw,
    ],
    edges: [
      supersedeEdge("edge:superseded", supersededRaw.id, supersededSummary.id),
    ],
    clusters: [
      cluster("cluster:stable", [stableA.id, stableB.id], "stable", {
        supportScore: 0.88,
      }),
      cluster(
        "cluster:superseded",
        [supersededRaw.id, supersededSummary.id],
        "stable",
        {
          representativeNodeId: supersededSummary.id,
          supportScore: 0.91,
        },
      ),
      cluster("cluster:decaying", [decayingRaw.id], "active", {
        supportScore: 0.1,
      }),
      cluster("cluster:active", [activeRaw.id], "active", {
        supportScore: 0.6,
      }),
      cluster("cluster:foreign", [foreignRaw.id], "stable", {
        scope: otherOwnerScope,
        supportScore: 0.99,
      }),
    ],
    capturedAt: NOW,
  };
}

describe("memory graph consolidation planning", () => {
  it("derives summary, deprecation, archive, and preserve candidates from cluster lifecycle", () => {
    const plan = buildMemoryGraphConsolidationPlan({
      ownerScope,
      snapshot: snapshot(),
      lifecycle: lifecycle(),
      now: NOW + 1,
      metadata: {
        mode: "phase-6",
      },
    });

    expect(plan.summaryCandidates).toEqual([
      expect.objectContaining({
        candidateId: "summary-candidate:cluster%3Astable",
        ownerScope,
        clusterId: "cluster:stable",
        sourceNodeIds: ["node:raw:stable-a", "node:raw:stable-b"],
        reasonCodes: expect.arrayContaining([
          "stable_cluster_summary_candidate",
          "cluster_lifecycle_dry_run",
        ]),
        metadata: expect.objectContaining({
          competitionKey: "cluster:stable:competition",
          evidenceCount: 2,
          lifecycleStatus: "stable",
          supportScore: 0.88,
        }),
      }),
    ]);
    expect(plan.deprecationPlans).toEqual([
      expect.objectContaining({
        ownerScope,
        sourceNodeIds: ["node:raw:superseded"],
        supersededByNodeId: "node:summary:superseded",
        reasonCodes: expect.arrayContaining([
          "superseded_cluster_deprecation_candidate",
          "supersede_relation_observed",
        ]),
      }),
    ]);
    expect(plan.archiveCandidateNodeIds).toEqual(["node:raw:decaying"]);
    expect(plan.preserveClusterIds).toEqual(["cluster:active"]);
    expect(plan.reasonCodes).toEqual(
      expect.arrayContaining([
        "graph_consolidation_plan_created",
        "stable_cluster_summary_candidate",
        "superseded_cluster_deprecation_candidate",
        "decaying_cluster_archive_candidate",
      ]),
    );
    expect(plan.metadata).toEqual({
      mode: "phase-6",
    });
  });

  it("adapts graph summary candidates to existing deprecation entries after summaries persist", () => {
    const plan = buildMemoryGraphConsolidationPlan({
      ownerScope,
      snapshot: snapshot(),
      lifecycle: lifecycle(),
      now: NOW + 1,
    });
    const result = buildMemoryGraphDeprecationEntries({
      persistedSummaryIds: ["summary-record:stable"],
      summaryCandidates: plan.summaryCandidates,
      reasonFor: (summaryId) => `graph_summarized_into:${summaryId}`,
    });

    expect(result.bySummary).toEqual({
      "summary-record:stable": ["node:raw:stable-a", "node:raw:stable-b"],
    });
    expect(result.entries).toEqual([
      expect.objectContaining({
        clusterKey: "cluster:stable",
        competitionKey: "cluster:stable:competition",
        action: "deprecate",
        recordIds: ["node:raw:stable-a", "node:raw:stable-b"],
        supersededBySummaryId: "summary-record:stable",
        deprecationReason: "graph_summarized_into:summary-record:stable",
      }),
    ]);
  });

  it("honors the MemoryConsolidationPlanner boundary without enabling runtime writes", async () => {
    const planner = createMemoryGraphConsolidationPlanner({
      maxSummaryCandidates: 1,
    });

    await expect(
      planner.plan({
        ownerScope,
        snapshot: snapshot(),
        lifecycle: lifecycle(),
        now: NOW + 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ownerScope,
        summaryCandidates: [
          expect.objectContaining({
            clusterId: "cluster:stable",
          }),
        ],
        deprecationPlans: [
          expect.objectContaining({
            supersededByNodeId: "node:summary:superseded",
          }),
        ],
      }),
    );
  });
});
