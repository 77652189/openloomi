import { describe, expect, it } from "vitest";
import {
  buildMemoryGraphUpdateDryRunPlan,
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
    createdAt: NOW,
    visibility: "default",
  };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  kind: MemoryGraphEdge["kind"] = "support",
  weight = 0.55,
  scope: OwnerScope = ownerScope,
): MemoryGraphEdge {
  return {
    id,
    ownerScope: scope,
    fromNodeId,
    toNodeId,
    kind,
    weight,
    confidence: weight,
    evidenceNodeIds: [fromNodeId],
    reasonCodes: [`existing_${kind}`],
    createdAt: NOW - 10,
  };
}

function snapshot(): MemoryGraphSnapshot {
  const oldPreference = node("node:old-preference");
  const supportingTrace = node("node:supporting-trace");
  const conflictingTrace = node("node:conflicting-trace");
  const existingSupport = edge(
    "edge:old-support",
    supportingTrace.id,
    oldPreference.id,
  );

  return {
    ownerScope,
    nodes: [oldPreference, supportingTrace, conflictingTrace],
    edges: [existingSupport],
    clusters: [
      {
        clusterId: "cluster:language",
        ownerScope,
        nodeIds: [oldPreference.id, supportingTrace.id],
        lifecycleStatus: "active",
        updatedAt: NOW - 10,
        reasonCodes: ["existing_active_cluster"],
      },
    ],
    capturedAt: NOW - 1,
  };
}

describe("memory graph update dry-run plan", () => {
  it("plans scoped graph operations without enabling persistence", () => {
    const existingSnapshot = snapshot();
    const newTrace = node("node:new-trace");
    const summary = node("node:summary-language", "summary");
    const plan = buildMemoryGraphUpdateDryRunPlan({
      ownerScope,
      existingSnapshot,
      newNodes: [newTrace, summary],
      now: NOW,
      relationSignals: [
        {
          fromNodeId: newTrace.id,
          toNodeId: "node:old-preference",
          kind: "support",
          weight: 0.78,
          confidence: 0.84,
          evidenceNodeIds: [newTrace.id],
          reasonCodes: ["same_preference_observed"],
        },
        {
          fromNodeId: "node:supporting-trace",
          toNodeId: "node:old-preference",
          kind: "support",
          weight: 0.91,
          evidenceNodeIds: [newTrace.id],
          reasonCodes: ["repeated_support"],
        },
        {
          fromNodeId: newTrace.id,
          toNodeId: "node:conflicting-trace",
          kind: "compete",
          weight: 0.71,
          reasonCodes: ["conflicting_preference"],
        },
        {
          fromNodeId: "node:old-preference",
          toNodeId: summary.id,
          kind: "supersede",
          weight: 1,
          reasonCodes: ["summary_sedimentation"],
        },
      ],
      weakeningSignals: [
        {
          edgeId: "edge:old-support",
          reasonCodes: ["newer_summary_preferred"],
        },
      ],
    });

    expect(plan.persistence).toEqual({
      mode: "dry-run",
      enabled: false,
    });
    expect(plan.summary).toEqual({
      candidateNodeCount: 2,
      candidateEdgeCount: 4,
      operationCount: 8,
      skippedSignalCount: 0,
      mutatesGraph: false,
      persistenceEnabled: false,
    });
    expect(plan.candidateNodes.map((item) => item.id)).toEqual([
      newTrace.id,
      summary.id,
    ]);
    expect(plan.candidateEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: newTrace.id,
          toNodeId: "node:old-preference",
          kind: "support",
          reasonCodes: expect.arrayContaining([
            "support_relation_observed",
            "same_preference_observed",
          ]),
        }),
        expect.objectContaining({
          id: "edge:old-support",
          kind: "support",
          weight: 0.91,
          reasonCodes: expect.arrayContaining([
            "existing_support",
            "edge_reinforcement_candidate",
            "repeated_support",
          ]),
        }),
        expect.objectContaining({
          fromNodeId: newTrace.id,
          toNodeId: "node:conflicting-trace",
          kind: "compete",
        }),
        expect.objectContaining({
          fromNodeId: "node:old-preference",
          toNodeId: summary.id,
          kind: "supersede",
        }),
      ]),
    );
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "create-node",
          nodeIds: [newTrace.id],
          ownerScope,
        }),
        expect.objectContaining({
          kind: "create-edge",
          nodeIds: [newTrace.id, "node:old-preference"],
        }),
        expect.objectContaining({
          kind: "reinforce-edge",
          edgeIds: ["edge:old-support"],
        }),
        expect.objectContaining({
          kind: "create-edge",
          nodeIds: [newTrace.id, "node:conflicting-trace"],
          reasonCodes: expect.arrayContaining(["compete_relation_observed"]),
        }),
        expect.objectContaining({
          kind: "supersede-node",
          nodeIds: ["node:old-preference", summary.id],
          supersededByNodeId: summary.id,
        }),
        expect.objectContaining({
          kind: "weaken-edge",
          edgeIds: ["edge:old-support"],
          reasonCodes: expect.arrayContaining(["newer_summary_preferred"]),
        }),
      ]),
    );
    expect(plan.reasonCodes).toEqual(
      expect.arrayContaining([
        "graph_update_dry_run",
        "persistence_disabled",
        "candidate_nodes_found",
        "candidate_edges_found",
      ]),
    );
  });

  it("skips cross-scope and missing graph signals without mutating defaults", () => {
    const crossScopeNode = node("node:foreign", "raw", otherOwnerScope);
    const plan = buildMemoryGraphUpdateDryRunPlan({
      ownerScope,
      existingSnapshot: snapshot(),
      newNodes: [crossScopeNode],
      now: NOW,
      relationSignals: [
        {
          fromNodeId: crossScopeNode.id,
          toNodeId: "node:old-preference",
          kind: "support",
        },
        {
          fromNodeId: "node:missing",
          toNodeId: "node:old-preference",
          kind: "related",
        },
      ],
      weakeningSignals: [
        {
          edgeId: "edge:missing",
        },
      ],
      metadata: {
        mode: "phase-2-test",
      },
    });

    expect(plan.candidateNodes).toEqual([]);
    expect(plan.candidateEdges).toEqual([]);
    expect(plan.operations).toEqual([]);
    expect(plan.persistence.enabled).toBe(false);
    expect(plan.summary).toEqual({
      candidateNodeCount: 0,
      candidateEdgeCount: 0,
      operationCount: 0,
      skippedSignalCount: 4,
      mutatesGraph: false,
      persistenceEnabled: false,
    });
    expect(plan.skippedSignals).toEqual([
      {
        signalType: "node",
        id: crossScopeNode.id,
        reasonCodes: ["owner_scope_mismatch"],
      },
      {
        signalType: "relation",
        id: `${crossScopeNode.id}->node:old-preference`,
        reasonCodes: ["missing_node"],
        metadata: undefined,
      },
      {
        signalType: "relation",
        id: "node:missing->node:old-preference",
        reasonCodes: ["missing_node"],
        metadata: undefined,
      },
      {
        signalType: "weakening",
        id: "edge:missing",
        reasonCodes: ["missing_edge"],
        metadata: undefined,
      },
    ]);
    expect(plan.reasonCodes).toEqual(
      expect.arrayContaining([
        "graph_update_dry_run",
        "persistence_disabled",
        "skipped_signals_found",
      ]),
    );
    expect(plan.metadata).toEqual({
      mode: "phase-2-test",
    });
  });
});
