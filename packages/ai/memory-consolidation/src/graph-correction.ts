import type {
  MemoryClusterLifecycleStatus,
  MemoryGraphClusterSnapshot,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphOperation,
  MemoryGraphPersistenceMode,
  MemoryGraphSnapshot,
  MemoryGraphUpdatePlan,
  OwnerScope,
} from "./graph-contracts";
import { applicabilityEquivalent } from "./graph-evolution";

export type MemoryGraphCorrectionAction =
  | {
      type: "correct-summary";
      clusterId: string;
      summaryId: string;
      correctedSummaryId: string;
    }
  | {
      type: "set-lifecycle";
      clusterId: string;
      lifecycleStatus: MemoryClusterLifecycleStatus;
    }
  | {
      type: "remove-member";
      clusterId: string;
      nodeId: string;
      separatedClusterId?: string;
    }
  | {
      type: "set-representative";
      clusterId: string;
      representativeNodeId: string;
    };

interface CommandPlanInput {
  ownerScope: OwnerScope;
  snapshot: MemoryGraphSnapshot;
  commandId: string;
  reason: string;
  requestedBy?: string;
  now: number;
  persistence: MemoryGraphPersistenceMode;
}

export interface BuildMemoryGraphCorrectionPlanInput extends CommandPlanInput {
  action: MemoryGraphCorrectionAction;
}

export interface BuildMemoryGraphRollbackPreparePlanInput extends CommandPlanInput {
  summaryId: string;
  sourceNodeIds: string[];
}

export interface BuildMemoryGraphRollbackFinalizePlanInput extends BuildMemoryGraphRollbackPreparePlanInput {
  previousLifecycleByClusterId?: Record<
    string,
    MemoryClusterLifecycleStatus | undefined
  >;
}

function scopeKey(scope: OwnerScope): string {
  return `${scope.tenantId ?? ""}|${scope.workspaceId ?? ""}|${scope.userId}`;
}

function sameScope(left: OwnerScope, right: OwnerScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function operationId(commandId: string, suffix: string): string {
  return `memory-graph-command:${encodeURIComponent(commandId)}:${suffix}`;
}

function metadata(input: CommandPlanInput): Record<string, unknown> {
  return {
    commandId: input.commandId,
    reason: input.reason,
    requestedBy: input.requestedBy,
  };
}

function copyNode(node: MemoryGraphNode): MemoryGraphNode {
  return {
    ...node,
    ownerScope: { ...node.ownerScope },
    applicability: node.applicability ? { ...node.applicability } : undefined,
    metadata: node.metadata ? { ...node.metadata } : undefined,
  };
}

function copyEdge(edge: MemoryGraphEdge): MemoryGraphEdge {
  return {
    ...edge,
    ownerScope: { ...edge.ownerScope },
    evidenceNodeIds: [...edge.evidenceNodeIds],
    reasonCodes: [...edge.reasonCodes],
    applicability: edge.applicability ? { ...edge.applicability } : undefined,
    metadata: edge.metadata ? { ...edge.metadata } : undefined,
  };
}

function copyCluster(
  cluster: MemoryGraphClusterSnapshot,
): MemoryGraphClusterSnapshot {
  return {
    ...cluster,
    ownerScope: { ...cluster.ownerScope },
    nodeIds: [...cluster.nodeIds],
    reasonCodes: [...cluster.reasonCodes],
    applicability: cluster.applicability
      ? { ...cluster.applicability }
      : undefined,
    metadata: cluster.metadata ? { ...cluster.metadata } : undefined,
  };
}

function emptyPlan(
  input: CommandPlanInput,
  reasonCodes: string[],
): MemoryGraphUpdatePlan {
  return {
    planId: `memory-graph-command:${encodeURIComponent(input.commandId)}`,
    ownerScope: { ...input.ownerScope },
    candidateNodes: [],
    candidateEdges: [],
    candidateClusters: [],
    operations: [],
    expectedVersion: input.snapshot.version ?? "0",
    persistence: input.persistence,
    reasonCodes,
    metadata: metadata(input),
  };
}

function sameApplicability(
  node: MemoryGraphNode,
  cluster: MemoryGraphClusterSnapshot,
): boolean {
  return applicabilityEquivalent(node.applicability, cluster.applicability);
}

export function buildMemoryGraphCorrectionPlan(
  input: BuildMemoryGraphCorrectionPlanInput,
): MemoryGraphUpdatePlan {
  if (!input.commandId || !input.reason) {
    return emptyPlan(input, ["memory_graph_correction_invalid_command"]);
  }
  const cluster = input.snapshot.clusters.find(
    (candidate) =>
      candidate.clusterId === input.action.clusterId &&
      sameScope(candidate.ownerScope, input.ownerScope),
  );
  if (!cluster) {
    return emptyPlan(input, ["memory_graph_correction_cluster_not_found"]);
  }

  const nodesById = new Map(
    input.snapshot.nodes
      .filter((node) => sameScope(node.ownerScope, input.ownerScope))
      .map((node) => [node.id, node]),
  );
  const candidateNodes: MemoryGraphNode[] = [];
  const candidateEdges: MemoryGraphEdge[] = [];
  const candidateClusters: MemoryGraphClusterSnapshot[] = [];
  const operations: MemoryGraphOperation[] = [];
  const commandMetadata = metadata(input);

  if (input.action.type === "remove-member") {
    const node = nodesById.get(input.action.nodeId);
    if (
      !node ||
      !cluster.nodeIds.includes(node.id) ||
      cluster.nodeIds.length <= 1
    ) {
      return emptyPlan(input, ["memory_graph_correction_member_not_found"]);
    }
    candidateNodes.push({
      ...copyNode(node),
      visibility: "default",
      updatedAt: input.now,
      metadata: {
        ...(node.metadata ?? {}),
        membershipCorrected: true,
        ...commandMetadata,
      },
    });
    const updatedCluster = copyCluster(cluster);
    updatedCluster.nodeIds = updatedCluster.nodeIds.filter(
      (nodeId) => nodeId !== node.id,
    );
    updatedCluster.updatedAt = input.now;
    updatedCluster.reasonCodes = unique([
      ...updatedCluster.reasonCodes,
      "memory_graph_membership_corrected",
    ]);
    if (updatedCluster.representativeNodeId === node.id) {
      updatedCluster.representativeNodeId = undefined;
    }
    const separatedClusterId =
      input.action.separatedClusterId ??
      `${cluster.clusterId}:corrected:${encodeURIComponent(node.id)}`;
    candidateClusters.push(updatedCluster, {
      clusterId: separatedClusterId,
      ownerScope: { ...input.ownerScope },
      nodeIds: [node.id],
      lifecycleStatus: "forming",
      supportScore: 0,
      updatedAt: input.now,
      reasonCodes: ["memory_graph_membership_corrected"],
      applicability: node.applicability ? { ...node.applicability } : undefined,
      metadata: {
        correctedFromClusterId: cluster.clusterId,
        ...commandMetadata,
      },
    });
    for (const edge of input.snapshot.edges) {
      if (
        (edge.kind !== "support" && edge.kind !== "supersede") ||
        !sameScope(edge.ownerScope, input.ownerScope) ||
        (edge.fromNodeId !== node.id && edge.toNodeId !== node.id)
      ) {
        continue;
      }
      const peerId =
        edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId;
      if (!cluster.nodeIds.includes(peerId)) continue;
      candidateEdges.push({
        ...copyEdge(edge),
        weight: 0,
        updatedAt: input.now,
        reasonCodes: unique([
          ...edge.reasonCodes,
          "memory_graph_membership_corrected",
        ]),
        metadata: {
          ...(edge.metadata ?? {}),
          inactive: true,
          ...commandMetadata,
        },
      });
    }
    operations.push({
      operationId: operationId(input.commandId, `remove-member:${node.id}`),
      ownerScope: { ...input.ownerScope },
      kind: "remove-cluster-member",
      nodeIds: [node.id],
      clusterId: cluster.clusterId,
      reasonCodes: ["memory_graph_membership_corrected"],
      metadata: { ...commandMetadata, separatedClusterId },
    });
  } else if (input.action.type === "set-lifecycle") {
    const updatedCluster = copyCluster(cluster);
    const fromStatus = updatedCluster.lifecycleStatus;
    updatedCluster.lifecycleStatus = input.action.lifecycleStatus;
    updatedCluster.updatedAt = input.now;
    updatedCluster.reasonCodes = unique([
      ...updatedCluster.reasonCodes,
      "memory_graph_lifecycle_corrected",
    ]);
    candidateClusters.push(updatedCluster);
    operations.push({
      operationId: operationId(
        input.commandId,
        `lifecycle:${cluster.clusterId}`,
      ),
      ownerScope: { ...input.ownerScope },
      kind: "set-cluster-lifecycle",
      nodeIds: [...cluster.nodeIds],
      clusterId: cluster.clusterId,
      fromStatus,
      toStatus: input.action.lifecycleStatus,
      reasonCodes: ["memory_graph_lifecycle_corrected"],
      metadata: commandMetadata,
    });
  } else {
    const representativeNodeId =
      input.action.type === "correct-summary"
        ? input.action.correctedSummaryId
        : input.action.representativeNodeId;
    const representative: MemoryGraphNode | undefined =
      input.action.type === "correct-summary"
        ? {
            id: representativeNodeId,
            ownerScope: { ...input.ownerScope },
            type: "summary",
            sourceId: input.action.summaryId,
            createdAt: input.now,
            updatedAt: input.now,
            visibility: "default",
            applicability: cluster.applicability
              ? { ...cluster.applicability }
              : undefined,
            metadata: {
              correctedFromSummaryId: input.action.summaryId,
              clusterId: cluster.clusterId,
              ...commandMetadata,
            },
          }
        : nodesById.get(representativeNodeId);
    if (
      !representative ||
      !sameScope(representative.ownerScope, input.ownerScope) ||
      !sameApplicability(representative, cluster) ||
      (representative.type === "raw" && representative.visibility !== "default")
    ) {
      return emptyPlan(input, [
        "memory_graph_correction_representative_not_found_or_inapplicable",
      ]);
    }
    const oldRepresentative = cluster.representativeNodeId
      ? nodesById.get(cluster.representativeNodeId)
      : undefined;
    if (oldRepresentative && oldRepresentative.id !== representativeNodeId) {
      candidateNodes.push({
        ...copyNode(oldRepresentative),
        visibility: "audit-only",
        updatedAt: input.now,
        metadata: {
          ...(oldRepresentative.metadata ?? {}),
          correctedByRepresentativeId: representativeNodeId,
          ...commandMetadata,
        },
      });
    }
    candidateNodes.push({
      ...copyNode(representative),
      visibility: "default",
      updatedAt: input.now,
    });
    const updatedCluster = copyCluster(cluster);
    updatedCluster.nodeIds = unique([
      ...updatedCluster.nodeIds,
      representativeNodeId,
    ]);
    updatedCluster.representativeNodeId = representativeNodeId;
    updatedCluster.updatedAt = input.now;
    updatedCluster.reasonCodes = unique([
      ...updatedCluster.reasonCodes,
      "memory_graph_representative_corrected",
    ]);
    candidateClusters.push(updatedCluster);
    operations.push({
      operationId: operationId(
        input.commandId,
        `representative:${representativeNodeId}`,
      ),
      ownerScope: { ...input.ownerScope },
      kind:
        input.action.type === "correct-summary"
          ? "correct-node"
          : "set-cluster-representative",
      nodeIds: unique([
        representativeNodeId,
        ...(oldRepresentative ? [oldRepresentative.id] : []),
      ]),
      clusterId: cluster.clusterId,
      supersededByNodeId: representativeNodeId,
      reasonCodes: ["memory_graph_representative_corrected"],
      metadata: {
        ...commandMetadata,
        previousRepresentativeNodeId: oldRepresentative?.id,
      },
    });
  }

  return {
    planId: `memory-graph-correction:${encodeURIComponent(input.commandId)}`,
    ownerScope: { ...input.ownerScope },
    candidateNodes,
    candidateEdges,
    candidateClusters,
    operations,
    expectedVersion: input.snapshot.version ?? "0",
    persistence: input.persistence,
    reasonCodes: unique([
      "memory_graph_correction_planned",
      ...operations.flatMap((operation) => operation.reasonCodes),
    ]),
    metadata: commandMetadata,
  };
}

export function buildMemoryGraphRollbackPreparePlan(
  input: BuildMemoryGraphRollbackPreparePlanInput,
): MemoryGraphUpdatePlan {
  const sourceIds = new Set(input.sourceNodeIds);
  const commandMetadata = metadata(input);
  const candidateNodes = input.snapshot.nodes
    .filter(
      (node) =>
        sourceIds.has(node.id) &&
        node.type === "raw" &&
        node.visibility !== "default" &&
        sameScope(node.ownerScope, input.ownerScope),
    )
    .map((node) => ({
      ...copyNode(node),
      visibility: "default" as const,
      updatedAt: input.now,
      metadata: {
        ...(node.metadata ?? {}),
        rollbackPreparedForSummaryId: input.summaryId,
        ...commandMetadata,
      },
    }));
  const operations = candidateNodes.map(
    (node): MemoryGraphOperation => ({
      operationId: operationId(input.commandId, `restore-node:${node.id}`),
      ownerScope: { ...input.ownerScope },
      kind: "restore-node",
      nodeIds: [node.id],
      supersededByNodeId: input.summaryId,
      reasonCodes: ["memory_graph_rollback_raw_visibility_prepared"],
      metadata: commandMetadata,
    }),
  );
  return {
    ...emptyPlan(input, ["memory_graph_rollback_prepare_planned"]),
    planId: `memory-graph-rollback-prepare:${encodeURIComponent(input.commandId)}`,
    candidateNodes,
    operations,
  };
}

export function buildMemoryGraphRollbackFinalizePlan(
  input: BuildMemoryGraphRollbackFinalizePlanInput,
): MemoryGraphUpdatePlan {
  const commandMetadata = metadata(input);
  const summaryNode = input.snapshot.nodes.find(
    (node) =>
      node.id === input.summaryId &&
      sameScope(node.ownerScope, input.ownerScope),
  );
  if (!summaryNode) {
    return emptyPlan(input, ["memory_graph_rollback_summary_not_found"]);
  }
  const candidateNodes: MemoryGraphNode[] = [];
  if (summaryNode.visibility !== "audit-only") {
    candidateNodes.push({
      ...copyNode(summaryNode),
      visibility: "audit-only",
      updatedAt: input.now,
      metadata: {
        ...(summaryNode.metadata ?? {}),
        rolledBack: true,
        ...commandMetadata,
      },
    });
  }
  const candidateEdges = input.snapshot.edges
    .filter(
      (edge) =>
        edge.kind === "supersede" &&
        edge.toNodeId === input.summaryId &&
        sameScope(edge.ownerScope, input.ownerScope) &&
        edge.metadata?.inactive !== true,
    )
    .map((edge) => ({
      ...copyEdge(edge),
      weight: 0,
      updatedAt: input.now,
      reasonCodes: unique([
        ...edge.reasonCodes,
        "memory_graph_rollback_applied",
      ]),
      metadata: {
        ...(edge.metadata ?? {}),
        inactive: true,
        rolledBack: true,
        ...commandMetadata,
      },
    }));
  const candidateClusters: MemoryGraphClusterSnapshot[] = [];
  for (const cluster of input.snapshot.clusters) {
    if (!sameScope(cluster.ownerScope, input.ownerScope)) continue;
    const isRepresentative = cluster.representativeNodeId === input.summaryId;
    const supersededBySummaryId = cluster.metadata?.supersededBySummaryId;
    if (!isRepresentative && supersededBySummaryId !== input.summaryId)
      continue;
    const updated = copyCluster(cluster);
    if (isRepresentative) updated.representativeNodeId = undefined;
    const previousStatus =
      input.previousLifecycleByClusterId?.[cluster.clusterId];
    if (previousStatus) updated.lifecycleStatus = previousStatus;
    else if (isRepresentative || updated.lifecycleStatus === "superseded") {
      updated.lifecycleStatus = "active";
    }
    updated.updatedAt = input.now;
    updated.reasonCodes = unique([
      ...updated.reasonCodes,
      "memory_graph_rollback_applied",
    ]);
    updated.metadata = {
      ...(updated.metadata ?? {}),
      rolledBack: true,
      ...commandMetadata,
    };
    candidateClusters.push(updated);
  }
  const operations: MemoryGraphOperation[] = [];
  if (candidateNodes.length > 0 || candidateEdges.length > 0) {
    operations.push({
      operationId: operationId(
        input.commandId,
        `rollback-summary:${input.summaryId}`,
      ),
      ownerScope: { ...input.ownerScope },
      kind: "rollback-supersession",
      nodeIds: unique([input.summaryId, ...input.sourceNodeIds]),
      supersededByNodeId: input.summaryId,
      reasonCodes: ["memory_graph_rollback_applied"],
      metadata: commandMetadata,
    });
  }
  operations.push(
    ...candidateClusters.map(
      (cluster): MemoryGraphOperation => ({
        operationId: operationId(
          input.commandId,
          `restore-cluster:${cluster.clusterId}`,
        ),
        ownerScope: { ...input.ownerScope },
        kind: "set-cluster-lifecycle",
        nodeIds: [...cluster.nodeIds],
        clusterId: cluster.clusterId,
        toStatus: cluster.lifecycleStatus,
        reasonCodes: ["memory_graph_rollback_applied"],
        metadata: commandMetadata,
      }),
    ),
  );
  return {
    ...emptyPlan(input, ["memory_graph_rollback_finalize_planned"]),
    planId: `memory-graph-rollback-finalize:${encodeURIComponent(input.commandId)}`,
    candidateNodes,
    candidateEdges,
    candidateClusters,
    operations,
  };
}
