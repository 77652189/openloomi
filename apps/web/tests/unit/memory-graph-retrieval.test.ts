import { describe, expect, it } from "vitest";
import {
  buildGraphAwareRetrievalDryRun,
  createGraphAwareRetrievalDryRunRetriever,
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
  type: MemoryGraphNode["type"],
  options: {
    visibility?: MemoryGraphNode["visibility"];
    scope?: OwnerScope;
    metadata?: Record<string, unknown>;
  } = {},
): MemoryGraphNode {
  return {
    id,
    ownerScope: options.scope ?? ownerScope,
    type,
    visibility: options.visibility ?? "default",
    createdAt: NOW,
    metadata: options.metadata,
  };
}

function supersedeEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  scope: OwnerScope = ownerScope,
): MemoryGraphEdge {
  return {
    id,
    ownerScope: scope,
    fromNodeId,
    toNodeId,
    kind: "supersede",
    weight: 1,
    evidenceNodeIds: [fromNodeId],
    reasonCodes: ["summary_sedimentation"],
    createdAt: NOW,
  };
}

function cluster(
  clusterId: string,
  nodeIds: string[],
  representativeNodeId: string,
  scope: OwnerScope = ownerScope,
): MemoryGraphClusterSnapshot {
  return {
    clusterId,
    ownerScope: scope,
    nodeIds,
    lifecycleStatus: "superseded",
    representativeNodeId,
    supportScore: 0.91,
    updatedAt: NOW,
    reasonCodes: ["supersede_relation_observed"],
  };
}

function snapshot(): MemoryGraphSnapshot {
  const deprecatedRaw = node("node:raw:old-language", "raw", {
    visibility: "deprecated",
    metadata: {
      supersededByNodeId: "node:summary:language",
      deprecationReasonCodes: ["summary_sedimentation"],
    },
  });
  const summary = node("node:summary:language", "summary");
  const freshRaw = node("node:raw:fresh-context", "raw");
  const auditOnlyRaw = node("node:raw:audit-only", "raw", {
    visibility: "audit-only",
  });
  const foreignSummary = node("node:summary:foreign", "summary", {
    scope: otherOwnerScope,
  });

  return {
    ownerScope,
    nodes: [deprecatedRaw, summary, freshRaw, auditOnlyRaw, foreignSummary],
    edges: [
      supersedeEdge("edge:supersede-language", deprecatedRaw.id, summary.id),
      supersedeEdge(
        "edge:foreign-supersede",
        deprecatedRaw.id,
        foreignSummary.id,
        otherOwnerScope,
      ),
    ],
    clusters: [
      cluster("cluster:language", [deprecatedRaw.id, summary.id], summary.id),
      cluster(
        "cluster:foreign",
        [foreignSummary.id],
        foreignSummary.id,
        otherOwnerScope,
      ),
    ],
    capturedAt: NOW,
  };
}

describe("graph-aware retrieval dry-run", () => {
  it("hides deprecated raw baseline nodes by default and prioritizes their summary representative", () => {
    const result = buildGraphAwareRetrievalDryRun({
      ownerScope,
      query: "language preference",
      baselineNodeIds: [
        "node:raw:old-language",
        "node:raw:fresh-context",
        "node:raw:audit-only",
        "node:summary:foreign",
      ],
      snapshot: snapshot(),
      visibilityMode: "default",
    });

    expect(result.rankedNodeIds).toEqual([
      "node:summary:language",
      "node:raw:fresh-context",
    ]);
    expect(result.hiddenDeprecatedNodeIds).toEqual(["node:raw:old-language"]);
    expect(result.expandedClusterIds).toEqual(["cluster:language"]);
    expect(result.auditTrail).toBeUndefined();
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "graph_retrieval_dry_run",
        "default_hides_deprecated_raw",
        "cluster_representative_prioritized",
        "missing_or_cross_scope_nodes_filtered",
      ]),
    );
    expect(result.metadata).toEqual(
      expect.objectContaining({
        baselineNodeCount: 4,
        rankedNodeCount: 2,
        query: "language preference",
        visibilityMode: "default",
      }),
    );
  });

  it("returns deprecated raw nodes and audit chain when includeDeprecated is true", () => {
    const result = buildGraphAwareRetrievalDryRun({
      ownerScope,
      query: "language preference",
      baselineNodeIds: ["node:raw:old-language", "node:raw:fresh-context"],
      snapshot: snapshot(),
      visibilityMode: "audit",
      includeDeprecated: true,
    });

    expect(result.rankedNodeIds).toEqual([
      "node:summary:language",
      "node:raw:old-language",
      "node:raw:fresh-context",
    ]);
    expect(result.hiddenDeprecatedNodeIds).toEqual([]);
    expect(result.auditTrail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerScope,
          nodeId: "node:summary:language",
          sourceNodeIds: ["node:raw:old-language"],
          edgeIds: ["edge:supersede-language"],
          reasonCodes: expect.arrayContaining([
            "graph_retrieval_audit_trail",
            "summary_sedimentation",
          ]),
        }),
        expect.objectContaining({
          ownerScope,
          nodeId: "node:raw:old-language",
          sourceNodeIds: ["node:raw:old-language"],
          edgeIds: ["edge:supersede-language"],
          reasonCodes: expect.arrayContaining([
            "graph_retrieval_audit_trail",
            "deprecated_raw_included",
          ]),
        }),
      ]),
    );
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "include_deprecated_requested",
        "audit_trail_available",
      ]),
    );
  });

  it("honors the GraphAwareRetriever boundary without mutating snapshot state", async () => {
    const graph = snapshot();
    const before = JSON.stringify(graph);
    const retriever = createGraphAwareRetrievalDryRunRetriever();

    await expect(
      retriever.compare({
        ownerScope,
        query: "language preference",
        baselineNodeIds: ["node:raw:old-language"],
        snapshot: graph,
        visibilityMode: "default",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        rankedNodeIds: ["node:summary:language"],
        hiddenDeprecatedNodeIds: ["node:raw:old-language"],
        expandedClusterIds: ["cluster:language"],
      }),
    );
    expect(JSON.stringify(graph)).toBe(before);
  });
});
