import { describe, expect, it } from "vitest";
import {
  buildMemoryGraphUpdateDryRunPlan,
  createInMemoryMemoryGraphStore,
  createNoopMemoryGraphStore,
  persistMemoryGraphPlan,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
  type MemoryGraphUpdatePlan,
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

function snapshot(nodes: MemoryGraphNode[]): MemoryGraphSnapshot {
  return {
    ownerScope,
    nodes,
    edges: [],
    clusters: [],
    capturedAt: NOW,
  };
}

function writePlanFromDryRun(
  plan: ReturnType<typeof buildMemoryGraphUpdateDryRunPlan>,
): MemoryGraphUpdatePlan {
  return {
    ...plan,
    persistence: {
      mode: "write",
      enabled: true,
    },
    reasonCodes: [...plan.reasonCodes, "opt_in_persistence_requested"],
  };
}

describe("memory graph opt-in persistence", () => {
  it("soft-deprecates superseded source nodes only after explicit write opt-in", async () => {
    const source = node("node:raw:language");
    const summary = node("node:summary:language", "summary");
    const store = createInMemoryMemoryGraphStore({
      snapshot: snapshot([source]),
      now: () => NOW + 1,
    });
    const dryRunPlan = buildMemoryGraphUpdateDryRunPlan({
      ownerScope,
      existingSnapshot: snapshot([source]),
      newNodes: [summary],
      relationSignals: [
        {
          fromNodeId: source.id,
          toNodeId: summary.id,
          kind: "supersede",
          weight: 1,
          evidenceNodeIds: [source.id],
          reasonCodes: ["summary_sedimentation"],
        },
      ],
      now: NOW,
    });

    const dryRunResult = await persistMemoryGraphPlan({
      store,
      plan: dryRunPlan,
    });
    expect(dryRunResult).toEqual(
      expect.objectContaining({
        mutatesGraph: false,
        diagnostics: ["memory_graph_persistence_noop"],
      }),
    );

    const writeResult = await persistMemoryGraphPlan({
      store,
      plan: writePlanFromDryRun(dryRunPlan),
    });
    expect(writeResult).toEqual(
      expect.objectContaining({
        mutatesGraph: true,
        diagnostics: ["memory_graph_persistence_applied"],
      }),
    );
    expect(
      writeResult.appliedOperations.map((operation) => operation.kind),
    ).toEqual(["create-node", "create-edge", "supersede-node"]);

    const persisted = await store.readSnapshot({ ownerScope });
    expect(persisted.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: source.id,
          visibility: "deprecated",
          metadata: expect.objectContaining({
            supersededByNodeId: summary.id,
            deprecatedAt: NOW + 1,
            deprecationReasonCodes: expect.arrayContaining([
              "summary_sedimentation",
            ]),
          }),
        }),
        expect.objectContaining({
          id: summary.id,
          type: "summary",
          visibility: "default",
        }),
      ]),
    );
    expect(persisted.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: source.id,
          toNodeId: summary.id,
          kind: "supersede",
          evidenceNodeIds: [source.id],
        }),
      ]),
    );

    await expect(
      store.readAuditTrail({
        ownerScope,
        nodeId: summary.id,
        includeDeprecated: false,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        sourceNodeIds: [],
      }),
    );
    await expect(
      store.readAuditTrail({
        ownerScope,
        nodeId: summary.id,
        includeDeprecated: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        sourceNodeIds: [source.id],
        operationIds: expect.arrayContaining([
          expect.stringContaining("supersede-node"),
        ]),
        reasonCodes: expect.arrayContaining(["summary_sedimentation"]),
      }),
    );
  });

  it("returns diagnostics instead of failing when graph store support is missing", async () => {
    const plan = writePlanFromDryRun(
      buildMemoryGraphUpdateDryRunPlan({
        ownerScope,
        existingSnapshot: snapshot([node("node:raw:1")]),
        newNodes: [node("node:summary:1", "summary")],
        relationSignals: [
          {
            fromNodeId: "node:raw:1",
            toNodeId: "node:summary:1",
            kind: "supersede",
          },
        ],
        now: NOW,
      }),
    );

    const result = await persistMemoryGraphPlan({ plan });

    expect(result).toEqual(
      expect.objectContaining({
        ownerScope,
        appliedOperations: [],
        mutatesGraph: false,
        diagnostics: ["memory_graph_store_missing"],
      }),
    );
    expect(result.skippedOperations).toHaveLength(plan.operations.length);
    expect(result.skippedOperations[0]?.reasonCodes).toEqual([
      "adapter_missing",
    ]);
  });

  it("keeps the no-op store read-compatible and write-safe by default", async () => {
    const source = node("node:raw:no-op");
    const store = createNoopMemoryGraphStore({
      snapshot: snapshot([source]),
    });
    const plan = writePlanFromDryRun(
      buildMemoryGraphUpdateDryRunPlan({
        ownerScope,
        existingSnapshot: snapshot([source]),
        newNodes: [node("node:summary:no-op", "summary")],
        relationSignals: [
          {
            fromNodeId: source.id,
            toNodeId: "node:summary:no-op",
            kind: "supersede",
          },
        ],
        now: NOW,
      }),
    );

    await expect(store.persistPlan(plan)).resolves.toEqual(
      expect.objectContaining({
        appliedOperations: [],
        mutatesGraph: false,
        diagnostics: ["memory_graph_persistence_noop"],
      }),
    );
    await expect(store.readSnapshot({ ownerScope })).resolves.toEqual(
      expect.objectContaining({
        nodes: [source],
        edges: [],
      }),
    );
  });

  it("rejects cross-scope write candidates before mutating graph state", async () => {
    const source = node("node:raw:scoped");
    const foreignSummary = node(
      "node:summary:foreign",
      "summary",
      otherOwnerScope,
    );
    const store = createInMemoryMemoryGraphStore({
      snapshot: snapshot([source]),
      now: () => NOW + 1,
    });
    const plan: MemoryGraphUpdatePlan = {
      ownerScope,
      candidateNodes: [foreignSummary],
      candidateEdges: [],
      operations: [
        {
          operationId: "op:create-foreign-summary",
          ownerScope,
          kind: "create-node",
          nodeIds: [foreignSummary.id],
          reasonCodes: ["foreign_candidate_fixture"],
        },
      ],
      persistence: {
        mode: "write",
        enabled: true,
      },
      reasonCodes: ["opt_in_persistence_requested"],
    };

    const result = await store.persistPlan(plan);

    expect(result).toEqual(
      expect.objectContaining({
        appliedOperations: [],
        mutatesGraph: false,
        diagnostics: ["memory_graph_owner_scope_error"],
      }),
    );
    expect(result.skippedOperations[0]?.reasonCodes).toEqual([
      "candidate_owner_scope_mismatch",
    ]);
    await expect(store.readSnapshot({ ownerScope })).resolves.toEqual(
      expect.objectContaining({
        nodes: [source],
        edges: [],
      }),
    );
  });

  it("does not duplicate graph writes or overwrite existing deprecation on repeat runs", async () => {
    const source = node("node:raw:repeat");
    const summary = node("node:summary:repeat", "summary");
    const store = createInMemoryMemoryGraphStore({
      snapshot: snapshot([source]),
      now: () => NOW + 1,
    });
    const plan = writePlanFromDryRun(
      buildMemoryGraphUpdateDryRunPlan({
        ownerScope,
        existingSnapshot: snapshot([source]),
        newNodes: [summary],
        relationSignals: [
          {
            fromNodeId: source.id,
            toNodeId: summary.id,
            kind: "supersede",
            weight: 1,
            reasonCodes: ["summary_sedimentation"],
          },
        ],
        now: NOW,
      }),
    );

    await expect(store.persistPlan(plan)).resolves.toEqual(
      expect.objectContaining({
        mutatesGraph: true,
      }),
    );
    const repeated = await store.persistPlan(plan);
    const persisted = await store.readSnapshot({ ownerScope });

    expect(repeated).toEqual(
      expect.objectContaining({
        appliedOperations: [],
        mutatesGraph: false,
        diagnostics: ["memory_graph_persistence_no_changes"],
      }),
    );
    expect(repeated.skippedOperations).toHaveLength(plan.operations.length);
    expect(
      persisted.nodes.filter((item) => item.id === summary.id),
    ).toHaveLength(1);
    expect(
      persisted.edges.filter((item) => item.kind === "supersede"),
    ).toHaveLength(1);
    expect(
      persisted.nodes.find((item) => item.id === source.id)?.metadata,
    ).toEqual(
      expect.objectContaining({
        supersededByNodeId: summary.id,
        deprecatedAt: NOW + 1,
        deprecationReasonCodes: expect.arrayContaining([
          "summary_sedimentation",
        ]),
      }),
    );
  });
});
