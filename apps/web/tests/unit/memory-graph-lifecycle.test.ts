import { describe, expect, it } from "vitest";
import {
  buildMemoryClusterLifecycleDryRun,
  type MemoryClusterLifecycleStatus,
  type MemoryGraphClusterSnapshot,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
  type OwnerScope,
} from "@openloomi/memory-consolidation";

const DAY_MS = 24 * 60 * 60 * 1000;
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
  options: {
    type?: MemoryGraphNode["type"];
    visibility?: MemoryGraphNode["visibility"];
    scope?: OwnerScope;
  } = {},
): MemoryGraphNode {
  return {
    id,
    ownerScope: options.scope ?? ownerScope,
    type: options.type ?? "raw",
    visibility: options.visibility ?? "default",
    createdAt: NOW - 10 * DAY_MS,
  };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  options: {
    kind?: MemoryGraphEdge["kind"];
    weight?: number;
    scope?: OwnerScope;
  } = {},
): MemoryGraphEdge {
  return {
    id,
    ownerScope: options.scope ?? ownerScope,
    fromNodeId,
    toNodeId,
    kind: options.kind ?? "support",
    weight: options.weight ?? 0.7,
    evidenceNodeIds: [fromNodeId],
    reasonCodes: [`${options.kind ?? "support"}_fixture`],
    createdAt: NOW - DAY_MS,
  };
}

function cluster(
  clusterId: string,
  nodeIds: string[],
  lifecycleStatus: MemoryClusterLifecycleStatus,
  options: {
    supportScore?: number;
    updatedAt?: number;
    representativeNodeId?: string;
    scope?: OwnerScope;
  } = {},
): MemoryGraphClusterSnapshot {
  return {
    clusterId,
    ownerScope: options.scope ?? ownerScope,
    nodeIds,
    lifecycleStatus,
    supportScore: options.supportScore,
    representativeNodeId: options.representativeNodeId,
    updatedAt: options.updatedAt ?? NOW - DAY_MS,
    reasonCodes: [`${lifecycleStatus}_fixture`],
  };
}

function snapshot(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  clusters: MemoryGraphClusterSnapshot[],
): MemoryGraphSnapshot {
  return {
    ownerScope,
    nodes,
    edges,
    clusters,
    capturedAt: NOW,
  };
}

describe("memory cluster lifecycle dry-run", () => {
  it("moves forming clusters to active and active clusters to stable as support deepens", () => {
    const formingA = node("forming-a");
    const formingB = node("forming-b");
    const activeA = node("active-a");
    const activeB = node("active-b");
    const activeC = node("active-c");
    const graph = snapshot(
      [formingA, formingB, activeA, activeB, activeC],
      [
        edge("edge:forming-support", formingA.id, formingB.id, {
          weight: 0.56,
        }),
        edge("edge:active-support-1", activeA.id, activeB.id, {
          weight: 0.86,
        }),
        edge("edge:active-support-2", activeB.id, activeC.id, {
          weight: 0.82,
        }),
      ],
      [
        cluster("cluster:forming", [formingA.id, formingB.id], "forming"),
        cluster(
          "cluster:active",
          [activeA.id, activeB.id, activeC.id],
          "active",
        ),
      ],
    );

    const result = buildMemoryClusterLifecycleDryRun({
      ownerScope,
      snapshot: graph,
      now: NOW,
    });

    expect(result.summary).toEqual(
      expect.objectContaining({
        clusterCount: 2,
        transitionCount: 2,
        consolidationEligibleClusterCount: 1,
        mutatesGraph: false,
        persistenceEnabled: false,
        statusCounts: {
          active: 1,
          stable: 1,
        },
      }),
    );
    expect(result.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterId: "cluster:forming",
          fromStatus: "forming",
          toStatus: "active",
          reasonCodes: ["support_deepened_cluster"],
        }),
        expect.objectContaining({
          clusterId: "cluster:active",
          fromStatus: "active",
          toStatus: "stable",
          reasonCodes: ["stable_support_threshold_met"],
        }),
      ]),
    );
    expect(result.consolidationEligibleClusterIds).toEqual(["cluster:active"]);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "cluster_lifecycle_dry_run",
        "support_deepened_cluster",
        "stable_support_threshold_met",
      ]),
    );
  });

  it("moves stale weak and strongly contested clusters toward decaying", () => {
    const staleA = node("stale-a");
    const staleB = node("stale-b");
    const contestedA = node("contested-a");
    const contestedB = node("contested-b");
    const graph = snapshot(
      [staleA, staleB, contestedA, contestedB],
      [
        edge("edge:stale-weak", staleA.id, staleB.id, {
          weight: 0.12,
        }),
        edge("edge:contested", contestedA.id, contestedB.id, {
          kind: "compete",
          weight: 0.88,
        }),
      ],
      [
        cluster("cluster:stale", [staleA.id, staleB.id], "active", {
          supportScore: 0.12,
          updatedAt: NOW - 90 * DAY_MS,
        }),
        cluster("cluster:contested", [contestedA.id], "stable", {
          supportScore: 0.8,
        }),
      ],
    );

    const result = buildMemoryClusterLifecycleDryRun({
      ownerScope,
      snapshot: graph,
      now: NOW,
    });

    expect(result.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterId: "cluster:stale",
          fromStatus: "active",
          toStatus: "decaying",
          reasonCodes: ["stale_or_unsupported_cluster"],
        }),
        expect.objectContaining({
          clusterId: "cluster:contested",
          fromStatus: "stable",
          toStatus: "decaying",
          reasonCodes: ["strong_competition_observed"],
        }),
      ]),
    );
    expect(result.consolidationEligibleClusterIds).toEqual([]);
    expect(result.analyses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterId: "cluster:contested",
          competeEdgeCount: 1,
          supportScore: 0.8,
        }),
      ]),
    );
  });

  it("moves sedimented clusters to superseded and hidden superseded clusters to audit-only", () => {
    const raw = node("raw-source");
    const summary = node("summary-node", { type: "summary" });
    const hiddenRaw = node("hidden-raw", { visibility: "deprecated" });
    const hiddenSummary = node("hidden-summary", {
      type: "summary",
      visibility: "audit-only",
    });
    const graph = snapshot(
      [raw, summary, hiddenRaw, hiddenSummary],
      [
        edge("edge:supersede", raw.id, summary.id, {
          kind: "supersede",
          weight: 1,
        }),
      ],
      [
        cluster("cluster:sedimented", [raw.id, summary.id], "stable", {
          supportScore: 0.9,
        }),
        cluster(
          "cluster:hidden",
          [hiddenRaw.id, hiddenSummary.id],
          "superseded",
          {
            representativeNodeId: hiddenSummary.id,
          },
        ),
      ],
    );

    const result = buildMemoryClusterLifecycleDryRun({
      ownerScope,
      snapshot: graph,
      now: NOW,
    });

    expect(result.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clusterId: "cluster:sedimented",
          fromStatus: "stable",
          toStatus: "superseded",
          representativeNodeId: summary.id,
          reasonCodes: ["supersede_relation_observed", "summary_sedimentation"],
        }),
        expect.objectContaining({
          clusterId: "cluster:hidden",
          fromStatus: "superseded",
          toStatus: "audit-only",
          representativeNodeId: hiddenSummary.id,
          reasonCodes: ["superseded_cluster_hidden_from_default"],
        }),
      ]),
    );
    expect(result.auditOnlyClusterIds).toEqual(["cluster:hidden"]);
    expect(result.summary.statusCounts).toEqual({
      superseded: 1,
      "audit-only": 1,
    });
  });

  it("skips clusters outside OwnerScope without writing graph state", () => {
    const local = node("local");
    const foreign = node("foreign", { scope: otherOwnerScope });
    const graph = snapshot(
      [local, foreign],
      [],
      [
        cluster("cluster:local", [local.id], "forming"),
        cluster("cluster:foreign", [foreign.id], "forming", {
          scope: otherOwnerScope,
        }),
      ],
    );

    const result = buildMemoryClusterLifecycleDryRun({
      ownerScope,
      snapshot: graph,
      now: NOW,
      metadata: {
        mode: "phase-4",
      },
    });

    expect(result.summary).toEqual(
      expect.objectContaining({
        clusterCount: 1,
        skippedClusterCount: 1,
        mutatesGraph: false,
        persistenceEnabled: false,
      }),
    );
    expect(result.skippedClusterIds).toEqual(["cluster:foreign"]);
    expect(result.metadata).toEqual({
      mode: "phase-4",
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["owner_scope_cluster_skipped"]),
    );
  });
});
