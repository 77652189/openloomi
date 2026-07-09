import { describe, expect, it } from "vitest";
import {
  buildGraphEvolutionReport,
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

function node(
  id: string,
  type: MemoryGraphNode["type"] = "raw",
): MemoryGraphNode {
  return {
    id,
    ownerScope,
    type,
    createdAt: NOW,
    visibility: "default",
  };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
): MemoryGraphEdge {
  return {
    id,
    ownerScope,
    fromNodeId,
    toNodeId,
    kind: "support",
    weight: 0.55,
    evidenceNodeIds: [fromNodeId],
    reasonCodes: ["existing_support"],
    createdAt: NOW - 1,
  };
}

function snapshot(): MemoryGraphSnapshot {
  const source = node("node:source");
  const preference = node("node:preference");
  const conflict = node("node:conflict");

  return {
    ownerScope,
    nodes: [source, preference, conflict],
    edges: [edge("edge:support", source.id, preference.id)],
    clusters: [],
    capturedAt: NOW - 1,
  };
}

describe("graph evolution report", () => {
  it("explains reinforcement, weakening, competition, and sedimentation from a dry-run plan", () => {
    const summary = node("node:summary", "summary");
    const newTrace = node("node:new-trace");
    const plan = buildMemoryGraphUpdateDryRunPlan({
      ownerScope,
      existingSnapshot: snapshot(),
      newNodes: [newTrace, summary],
      now: NOW,
      relationSignals: [
        {
          fromNodeId: newTrace.id,
          toNodeId: "node:preference",
          kind: "support",
          weight: 0.84,
          reasonCodes: ["repeated_support"],
        },
        {
          fromNodeId: "node:source",
          toNodeId: "node:preference",
          kind: "support",
          weight: 0.9,
          reasonCodes: ["fresh_support_evidence"],
        },
        {
          fromNodeId: newTrace.id,
          toNodeId: "node:conflict",
          kind: "compete",
          weight: 0.72,
          reasonCodes: ["conflicting_preference"],
        },
        {
          fromNodeId: "node:source",
          toNodeId: summary.id,
          kind: "supersede",
          weight: 1,
          reasonCodes: ["summary_sedimentation"],
        },
      ],
      weakeningSignals: [
        {
          edgeId: "edge:support",
          reasonCodes: ["older_edge_decay"],
        },
      ],
    });
    const report = buildGraphEvolutionReport({
      reportId: "report:dry-run",
      generatedAt: NOW + 1,
      plan,
      metadata: {
        mode: "phase-3",
      },
    });

    expect(report.summary).toEqual(
      expect.objectContaining({
        ownerScope,
        dryRun: true,
        mutatesGraph: false,
        mutatesStorage: false,
        mutatesRuntime: false,
        mutatesRetrieval: false,
        candidateNodeCount: 2,
        candidateEdgeCount: 4,
        operationCount: 8,
        skippedSignalCount: 0,
        operationCounts: {
          "create-node": 2,
          "create-edge": 3,
          "reinforce-edge": 1,
          "supersede-node": 1,
          "weaken-edge": 1,
        },
      }),
    );
    expect(report.summary.explanationCounts).toEqual(
      expect.objectContaining({
        node: 2,
        reinforcement: 2,
        competition: 1,
        sedimentation: 2,
        weakening: 1,
      }),
    );
    expect(report.operationExplanations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "reinforcement",
          kind: "reinforce-edge",
          edgeIds: ["edge:support"],
          summary:
            "Existing relation edge would be reinforced by new evidence.",
          reasonCodes: expect.arrayContaining(["fresh_support_evidence"]),
        }),
        expect.objectContaining({
          category: "weakening",
          kind: "weaken-edge",
          edgeIds: ["edge:support"],
          summary:
            "Existing relation edge would be weakened or marked for decay.",
          reasonCodes: expect.arrayContaining(["older_edge_decay"]),
        }),
        expect.objectContaining({
          category: "competition",
          relationKind: "compete",
          summary:
            "Competing memories would be connected as conflicting alternatives.",
          reasonCodes: expect.arrayContaining(["conflicting_preference"]),
        }),
        expect.objectContaining({
          category: "sedimentation",
          kind: "supersede-node",
          supersededByNodeId: summary.id,
          summary:
            "Source memory would be superseded by a graph representative.",
          reasonCodes: expect.arrayContaining(["summary_sedimentation"]),
        }),
      ]),
    );
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        "graph_evolution_report",
        "graph_update_dry_run",
        "reinforcement_explained",
        "weakening_explained",
        "competition_explained",
        "sedimentation_explained",
      ]),
    );
    expect(report.metadata).toEqual({
      mode: "phase-3",
    });
  });

  it("turns skipped graph signals into audit-ready warnings without writes", () => {
    const plan = buildMemoryGraphUpdateDryRunPlan({
      ownerScope,
      existingSnapshot: snapshot(),
      now: NOW,
      relationSignals: [
        {
          fromNodeId: "node:missing",
          toNodeId: "node:preference",
          kind: "related",
        },
      ],
    });
    const report = buildGraphEvolutionReport({
      reportId: "report:skipped",
      generatedAt: NOW + 1,
      plan,
      warnings: ["dry-run skipped relation signals"],
    });

    expect(report.summary).toEqual(
      expect.objectContaining({
        dryRun: true,
        mutatesGraph: false,
        warningCount: 2,
        operationCount: 0,
        skippedSignalCount: 1,
      }),
    );
    expect(report.skippedSignalExplanations).toEqual([
      {
        signalType: "relation",
        id: "node:missing->node:preference",
        summary:
          "Signal was skipped because required graph context was missing.",
        reasonCodes: ["missing_node"],
        metadata: undefined,
      },
    ]);
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        "skipped_signals_explained",
        "graph_evolution_report_warning",
      ]),
    );
    expect(report.warnings).toEqual(["dry-run skipped relation signals"]);
  });
});
