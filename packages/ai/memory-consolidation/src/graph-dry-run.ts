import type {
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphOperation,
  MemoryGraphRelationKind,
  MemoryGraphSnapshot,
  MemoryGraphUpdatePlan,
  OwnerScope,
} from "./graph-contracts";

export interface MemoryGraphRelationSignal {
  fromNodeId: string;
  toNodeId: string;
  kind: MemoryGraphRelationKind;
  weight?: number;
  confidence?: number;
  evidenceNodeIds?: string[];
  reasonCodes?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryGraphWeakeningSignal {
  edgeId: string;
  nodeIds?: string[];
  evidenceNodeIds?: string[];
  reasonCodes?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryGraphSkippedSignal {
  signalType: "node" | "relation" | "weakening";
  id: string;
  reasonCodes: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryGraphUpdateDryRunSummary {
  candidateNodeCount: number;
  candidateEdgeCount: number;
  operationCount: number;
  skippedSignalCount: number;
  mutatesGraph: false;
  persistenceEnabled: false;
}

export interface MemoryGraphUpdateDryRunPlan extends MemoryGraphUpdatePlan {
  summary: MemoryGraphUpdateDryRunSummary;
  skippedSignals: MemoryGraphSkippedSignal[];
}

export interface BuildMemoryGraphUpdateDryRunPlanInput {
  ownerScope: OwnerScope;
  existingSnapshot: MemoryGraphSnapshot;
  newNodes?: MemoryGraphNode[];
  relationSignals?: MemoryGraphRelationSignal[];
  weakeningSignals?: MemoryGraphWeakeningSignal[];
  now: number;
  metadata?: Record<string, unknown>;
}

function ownerScopeKey(scope: OwnerScope): string {
  return `${scope.tenantId ?? ""}|${scope.workspaceId ?? ""}|${scope.userId}`;
}

function sameOwnerScope(left: OwnerScope, right: OwnerScope): boolean {
  return ownerScopeKey(left) === ownerScopeKey(right);
}

function isNodeInScope(node: MemoryGraphNode, ownerScope: OwnerScope): boolean {
  return sameOwnerScope(node.ownerScope, ownerScope);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function relationKey(
  fromNodeId: string,
  toNodeId: string,
  kind: MemoryGraphRelationKind,
): string {
  return `${kind}:${fromNodeId}->${toNodeId}`;
}

function relationEdgeId(signal: MemoryGraphRelationSignal): string {
  return `edge:${encodeIdPart(signal.kind)}:${encodeIdPart(
    signal.fromNodeId,
  )}:${encodeIdPart(signal.toNodeId)}`;
}

function operationId(kind: string, id: string): string {
  return `op:${kind}:${encodeIdPart(id)}`;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function signalReasonCodes(
  defaults: string[],
  provided: string[] | undefined,
): string[] {
  return uniqueValues([...defaults, ...(provided ?? [])]);
}

function scopedEvidenceNodeIds(
  evidenceNodeIds: string[] | undefined,
  nodesById: Map<string, MemoryGraphNode>,
  ownerScope: OwnerScope,
): string[] {
  return uniqueValues(evidenceNodeIds ?? []).filter((nodeId) => {
    const node = nodesById.get(nodeId);
    return node !== undefined && isNodeInScope(node, ownerScope);
  });
}

export function buildMemoryGraphUpdateDryRunPlan(
  input: BuildMemoryGraphUpdateDryRunPlanInput,
): MemoryGraphUpdateDryRunPlan {
  const skippedSignals: MemoryGraphSkippedSignal[] = [];
  const existingNodesById = new Map(
    input.existingSnapshot.nodes.map((node) => [node.id, node]),
  );
  const acceptedNewNodes: MemoryGraphNode[] = [];
  const nodesById = new Map(existingNodesById);
  const operations: MemoryGraphOperation[] = [];

  for (const node of input.newNodes ?? []) {
    if (!isNodeInScope(node, input.ownerScope)) {
      skippedSignals.push({
        signalType: "node",
        id: node.id,
        reasonCodes: ["owner_scope_mismatch"],
      });
      continue;
    }

    if (nodesById.has(node.id)) {
      skippedSignals.push({
        signalType: "node",
        id: node.id,
        reasonCodes: ["node_already_exists"],
      });
      continue;
    }

    acceptedNewNodes.push(node);
    nodesById.set(node.id, node);
    operations.push({
      operationId: operationId("create-node", node.id),
      ownerScope: input.ownerScope,
      kind: "create-node",
      nodeIds: [node.id],
      reasonCodes: ["new_memory_node_candidate"],
    });
  }

  const existingEdgesByRelation = new Map(
    input.existingSnapshot.edges.map((edge) => [
      relationKey(edge.fromNodeId, edge.toNodeId, edge.kind),
      edge,
    ]),
  );
  const existingEdgesById = new Map(
    input.existingSnapshot.edges.map((edge) => [edge.id, edge]),
  );
  const candidateEdges: MemoryGraphEdge[] = [];

  for (const signal of input.relationSignals ?? []) {
    const fromNode = nodesById.get(signal.fromNodeId);
    const toNode = nodesById.get(signal.toNodeId);
    if (fromNode === undefined || toNode === undefined) {
      skippedSignals.push({
        signalType: "relation",
        id: `${signal.fromNodeId}->${signal.toNodeId}`,
        reasonCodes: ["missing_node"],
        metadata: signal.metadata,
      });
      continue;
    }

    if (
      !isNodeInScope(fromNode, input.ownerScope) ||
      !isNodeInScope(toNode, input.ownerScope)
    ) {
      skippedSignals.push({
        signalType: "relation",
        id: `${signal.fromNodeId}->${signal.toNodeId}`,
        reasonCodes: ["owner_scope_mismatch"],
        metadata: signal.metadata,
      });
      continue;
    }

    const relation = relationKey(
      signal.fromNodeId,
      signal.toNodeId,
      signal.kind,
    );
    const existingEdge = existingEdgesByRelation.get(relation);
    const reasonCodes = signalReasonCodes(
      [`${signal.kind}_relation_observed`],
      signal.reasonCodes,
    );
    const evidenceNodeIds = scopedEvidenceNodeIds(
      signal.evidenceNodeIds ?? [signal.fromNodeId],
      nodesById,
      input.ownerScope,
    );

    if (existingEdge !== undefined) {
      const proposedWeight = clamp01(signal.weight ?? existingEdge.weight);
      candidateEdges.push({
        ...existingEdge,
        weight: Math.max(existingEdge.weight, proposedWeight),
        confidence: signal.confidence ?? existingEdge.confidence,
        evidenceNodeIds: uniqueValues([
          ...existingEdge.evidenceNodeIds,
          ...evidenceNodeIds,
        ]),
        reasonCodes: uniqueValues([
          ...existingEdge.reasonCodes,
          ...reasonCodes,
          "edge_reinforcement_candidate",
        ]),
        updatedAt: input.now,
        metadata: {
          ...existingEdge.metadata,
          ...signal.metadata,
        },
      });
      operations.push({
        operationId: operationId("reinforce-edge", existingEdge.id),
        ownerScope: input.ownerScope,
        kind: "reinforce-edge",
        nodeIds: [signal.fromNodeId, signal.toNodeId],
        edgeIds: [existingEdge.id],
        reasonCodes: uniqueValues([
          ...reasonCodes,
          "edge_reinforcement_candidate",
        ]),
        metadata: {
          previousWeight: existingEdge.weight,
          proposedWeight,
          ...signal.metadata,
        },
      });
      continue;
    }

    const edge: MemoryGraphEdge = {
      id: relationEdgeId(signal),
      ownerScope: input.ownerScope,
      fromNodeId: signal.fromNodeId,
      toNodeId: signal.toNodeId,
      kind: signal.kind,
      weight: clamp01(signal.weight ?? 0.5),
      confidence: signal.confidence,
      evidenceNodeIds,
      reasonCodes,
      createdAt: input.now,
      metadata: signal.metadata,
    };
    candidateEdges.push(edge);
    operations.push({
      operationId: operationId("create-edge", edge.id),
      ownerScope: input.ownerScope,
      kind: "create-edge",
      nodeIds: [signal.fromNodeId, signal.toNodeId],
      edgeIds: [edge.id],
      reasonCodes: uniqueValues([...reasonCodes, "new_edge_candidate"]),
      metadata: signal.metadata,
    });

    if (signal.kind === "supersede") {
      operations.push({
        operationId: operationId("supersede-node", signal.fromNodeId),
        ownerScope: input.ownerScope,
        kind: "supersede-node",
        nodeIds: [signal.fromNodeId, signal.toNodeId],
        edgeIds: [edge.id],
        supersededByNodeId: signal.toNodeId,
        reasonCodes: uniqueValues([...reasonCodes, "supersession_candidate"]),
        metadata: signal.metadata,
      });
    }
  }

  for (const signal of input.weakeningSignals ?? []) {
    const edge = existingEdgesById.get(signal.edgeId);
    if (edge === undefined) {
      skippedSignals.push({
        signalType: "weakening",
        id: signal.edgeId,
        reasonCodes: ["missing_edge"],
        metadata: signal.metadata,
      });
      continue;
    }

    if (!sameOwnerScope(edge.ownerScope, input.ownerScope)) {
      skippedSignals.push({
        signalType: "weakening",
        id: signal.edgeId,
        reasonCodes: ["owner_scope_mismatch"],
        metadata: signal.metadata,
      });
      continue;
    }

    const reasonCodes = signalReasonCodes(
      ["edge_weakening_candidate"],
      signal.reasonCodes,
    );
    operations.push({
      operationId: operationId("weaken-edge", edge.id),
      ownerScope: input.ownerScope,
      kind: "weaken-edge",
      nodeIds: signal.nodeIds ?? [edge.fromNodeId, edge.toNodeId],
      edgeIds: [edge.id],
      reasonCodes,
      metadata: signal.metadata,
    });
  }

  const reasonCodes = uniqueValues([
    "graph_update_dry_run",
    "persistence_disabled",
    ...(acceptedNewNodes.length > 0 ? ["candidate_nodes_found"] : []),
    ...(candidateEdges.length > 0 ? ["candidate_edges_found"] : []),
    ...(skippedSignals.length > 0 ? ["skipped_signals_found"] : []),
  ]);

  return {
    ownerScope: input.ownerScope,
    candidateNodes: acceptedNewNodes,
    candidateEdges,
    operations,
    persistence: {
      mode: "dry-run",
      enabled: false,
    },
    skippedSignals,
    summary: {
      candidateNodeCount: acceptedNewNodes.length,
      candidateEdgeCount: candidateEdges.length,
      operationCount: operations.length,
      skippedSignalCount: skippedSignals.length,
      mutatesGraph: false,
      persistenceEnabled: false,
    },
    reasonCodes,
    metadata: input.metadata,
  };
}
