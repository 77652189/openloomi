import type {
  MemoryClusterLifecycleStatus,
  MemoryGraphAuditQuery,
  MemoryGraphAuditTrail,
  MemoryGraphClusterSnapshot,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphOperation,
  MemoryGraphSnapshot,
  MemoryGraphSnapshotQuery,
  MemoryGraphStore,
  MemoryGraphUpdatePlan,
  MemoryGraphUpdateResult,
  OwnerScope,
} from "./graph-contracts";

export interface PersistMemoryGraphPlanInput {
  store?: MemoryGraphStore;
  plan: MemoryGraphUpdatePlan;
  metadata?: Record<string, unknown>;
}

export interface CreateNoopMemoryGraphStoreInput {
  snapshot?: MemoryGraphSnapshot;
  diagnostics?: string[];
}

export interface CreateInMemoryMemoryGraphStoreInput {
  snapshot?: MemoryGraphSnapshot;
  now?: () => number;
}

interface MutableGraphState {
  nodesById: Map<string, MemoryGraphNode>;
  edgesById: Map<string, MemoryGraphEdge>;
  clustersById: Map<string, MemoryGraphClusterSnapshot>;
  auditTrailsByKey: Map<string, MemoryGraphAuditTrail>;
}

const DEFAULT_NOOP_DIAGNOSTIC = "memory_graph_persistence_noop";

function ownerScopeKey(scope: OwnerScope): string {
  return `${scope.tenantId ?? ""}|${scope.workspaceId ?? ""}|${scope.userId}`;
}

function auditTrailKey(ownerScope: OwnerScope, nodeId: string): string {
  return `${ownerScopeKey(ownerScope)}|${nodeId}`;
}

function sameOwnerScope(left: OwnerScope, right: OwnerScope): boolean {
  return ownerScopeKey(left) === ownerScopeKey(right);
}

function hasOwnerScope(scope: OwnerScope | undefined): scope is OwnerScope {
  return typeof scope?.userId === "string" && scope.userId.length > 0;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (next === undefined) {
    return existing;
  }
  if (existing === undefined) {
    return { ...next };
  }
  return {
    ...existing,
    ...next,
  };
}

function hasNewMetadata(
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): boolean {
  if (next === undefined) {
    return false;
  }
  return Object.entries(next).some(([key, value]) => existing?.[key] !== value);
}

function noOpResult(
  plan: MemoryGraphUpdatePlan,
  diagnostic: string,
  reasonCodes: string[],
  metadata?: Record<string, unknown>,
): MemoryGraphUpdateResult {
  return {
    ownerScope: plan.ownerScope,
    appliedOperations: [],
    skippedOperations: plan.operations.map((operation) => ({
      operation,
      reasonCodes,
    })),
    mutatesGraph: false,
    diagnostics: [diagnostic],
    metadata: mergeMetadata(plan.metadata, metadata),
  };
}

function shouldPersist(plan: MemoryGraphUpdatePlan): boolean {
  return plan.persistence.enabled && plan.persistence.mode === "write";
}

export async function persistMemoryGraphPlan(
  input: PersistMemoryGraphPlanInput,
): Promise<MemoryGraphUpdateResult> {
  if (!shouldPersist(input.plan)) {
    return noOpResult(
      input.plan,
      DEFAULT_NOOP_DIAGNOSTIC,
      ["persistence_not_enabled"],
      input.metadata,
    );
  }

  if (input.store === undefined) {
    return noOpResult(
      input.plan,
      "memory_graph_store_missing",
      ["adapter_missing"],
      input.metadata,
    );
  }

  try {
    return await input.store.persistPlan(input.plan);
  } catch (error) {
    return noOpResult(
      input.plan,
      "memory_graph_store_error",
      ["adapter_error"],
      {
        ...input.metadata,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function emptySnapshot(
  ownerScope: OwnerScope,
  capturedAt = 0,
): MemoryGraphSnapshot {
  return {
    ownerScope,
    nodes: [],
    edges: [],
    clusters: [],
    capturedAt,
  };
}

function filterSnapshot(
  snapshot: MemoryGraphSnapshot,
  query: MemoryGraphSnapshotQuery,
): MemoryGraphSnapshot {
  const nodeIdFilter =
    query.nodeIds === undefined ? undefined : new Set(query.nodeIds);
  const clusterIdFilter =
    query.clusterIds === undefined ? undefined : new Set(query.clusterIds);
  const includeAuditOnly = query.includeAuditOnly ?? false;
  const nodes = snapshot.nodes.filter(
    (node) =>
      sameOwnerScope(node.ownerScope, query.ownerScope) &&
      (nodeIdFilter === undefined || nodeIdFilter.has(node.id)) &&
      (includeAuditOnly || node.visibility !== "audit-only"),
  );
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges.filter(
    (edge) =>
      sameOwnerScope(edge.ownerScope, query.ownerScope) &&
      visibleNodeIds.has(edge.fromNodeId) &&
      visibleNodeIds.has(edge.toNodeId),
  );
  const clusters = snapshot.clusters.filter(
    (cluster) =>
      sameOwnerScope(cluster.ownerScope, query.ownerScope) &&
      (clusterIdFilter === undefined ||
        clusterIdFilter.has(cluster.clusterId)) &&
      (includeAuditOnly || cluster.lifecycleStatus !== "audit-only"),
  );

  return {
    ownerScope: query.ownerScope,
    nodes,
    edges,
    clusters,
    version: snapshot.version,
    capturedAt: snapshot.capturedAt,
  };
}

export function createNoopMemoryGraphStore(
  input: CreateNoopMemoryGraphStoreInput = {},
): MemoryGraphStore {
  return {
    async readSnapshot(query) {
      return filterSnapshot(
        input.snapshot ?? emptySnapshot(query.ownerScope),
        query,
      );
    },
    async persistPlan(plan) {
      return noOpResult(
        plan,
        input.diagnostics?.[0] ?? DEFAULT_NOOP_DIAGNOSTIC,
        ["adapter_noop"],
      );
    },
    async readAuditTrail(query) {
      return {
        ownerScope: query.ownerScope,
        nodeId: query.nodeId,
        sourceNodeIds: [],
        edgeIds: [],
        operationIds: [],
        reasonCodes: ["audit_trail_unavailable"],
      };
    },
  };
}

function cloneSnapshot(snapshot: MemoryGraphSnapshot): MutableGraphState {
  return {
    nodesById: new Map(snapshot.nodes.map((node) => [node.id, { ...node }])),
    edgesById: new Map(snapshot.edges.map((edge) => [edge.id, { ...edge }])),
    clustersById: new Map(
      snapshot.clusters.map((cluster) => [cluster.clusterId, { ...cluster }]),
    ),
    auditTrailsByKey: new Map(),
  };
}

function snapshotFromState(
  ownerScope: OwnerScope,
  state: MutableGraphState,
  capturedAt: number,
): MemoryGraphSnapshot {
  return {
    ownerScope,
    nodes: [...state.nodesById.values()],
    edges: [...state.edgesById.values()],
    clusters: [...state.clustersById.values()],
    capturedAt,
  };
}

function candidateScopeMismatch(plan: MemoryGraphUpdatePlan): boolean {
  return (
    plan.candidateNodes.some(
      (node) => !sameOwnerScope(node.ownerScope, plan.ownerScope),
    ) ||
    plan.candidateEdges.some(
      (edge) => !sameOwnerScope(edge.ownerScope, plan.ownerScope),
    )
  );
}

function operationScopeMismatch(
  operation: MemoryGraphOperation,
  ownerScope: OwnerScope,
): boolean {
  return !sameOwnerScope(operation.ownerScope, ownerScope);
}

function validatePlanScope(plan: MemoryGraphUpdatePlan): string[] {
  const reasonCodes: string[] = [];
  if (!hasOwnerScope(plan.ownerScope)) {
    reasonCodes.push("owner_scope_missing");
  }
  if (candidateScopeMismatch(plan)) {
    reasonCodes.push("candidate_owner_scope_mismatch");
  }
  if (
    plan.operations.some((operation) =>
      operationScopeMismatch(operation, plan.ownerScope),
    )
  ) {
    reasonCodes.push("operation_owner_scope_mismatch");
  }
  return reasonCodes;
}

function mergeAuditTrail(
  state: MutableGraphState,
  ownerScope: OwnerScope,
  nodeId: string,
  patch: Omit<MemoryGraphAuditTrail, "ownerScope" | "nodeId">,
): void {
  const key = auditTrailKey(ownerScope, nodeId);
  const existing = state.auditTrailsByKey.get(key);
  state.auditTrailsByKey.set(key, {
    ownerScope,
    nodeId,
    sourceNodeIds: uniqueValues([
      ...(existing?.sourceNodeIds ?? []),
      ...patch.sourceNodeIds,
    ]),
    edgeIds: uniqueValues([...(existing?.edgeIds ?? []), ...patch.edgeIds]),
    operationIds: uniqueValues([
      ...(existing?.operationIds ?? []),
      ...patch.operationIds,
    ]),
    reasonCodes: uniqueValues([
      ...(existing?.reasonCodes ?? []),
      ...patch.reasonCodes,
    ]),
    metadata: mergeMetadata(existing?.metadata, patch.metadata),
  });
}

function scopedExistingNode(
  state: MutableGraphState,
  nodeId: string,
  ownerScope: OwnerScope,
): MemoryGraphNode | undefined {
  const node = state.nodesById.get(nodeId);
  if (node === undefined || !sameOwnerScope(node.ownerScope, ownerScope)) {
    return undefined;
  }
  return node;
}

function applyCreateNode(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  candidatesById: Map<string, MemoryGraphNode>,
): boolean {
  let changed = false;
  for (const nodeId of operation.nodeIds) {
    if (state.nodesById.has(nodeId)) {
      continue;
    }
    const candidate = candidatesById.get(nodeId);
    if (candidate === undefined) {
      continue;
    }
    state.nodesById.set(nodeId, { ...candidate });
    changed = true;
  }
  return changed;
}

function mergeEdge(
  existing: MemoryGraphEdge,
  candidate: MemoryGraphEdge,
  now: number,
): { edge: MemoryGraphEdge; changed: boolean } {
  const evidenceNodeIds = uniqueValues([
    ...existing.evidenceNodeIds,
    ...candidate.evidenceNodeIds,
  ]);
  const reasonCodes = uniqueValues([
    ...existing.reasonCodes,
    ...candidate.reasonCodes,
  ]);
  const metadata = mergeMetadata(existing.metadata, candidate.metadata);
  const next: MemoryGraphEdge = {
    ...existing,
    weight: Math.max(existing.weight, candidate.weight),
    confidence: candidate.confidence ?? existing.confidence,
    evidenceNodeIds,
    reasonCodes,
    metadata,
  };
  const changed =
    next.weight !== existing.weight ||
    next.confidence !== existing.confidence ||
    evidenceNodeIds.length !== existing.evidenceNodeIds.length ||
    reasonCodes.length !== existing.reasonCodes.length ||
    hasNewMetadata(existing.metadata, candidate.metadata);

  return {
    edge: changed ? { ...next, updatedAt: now } : existing,
    changed,
  };
}

function applyCreateEdge(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  candidatesById: Map<string, MemoryGraphEdge>,
): boolean {
  let changed = false;
  for (const edgeId of operation.edgeIds ?? []) {
    if (state.edgesById.has(edgeId)) {
      continue;
    }
    const candidate = candidatesById.get(edgeId);
    if (candidate === undefined) {
      continue;
    }
    state.edgesById.set(edgeId, { ...candidate });
    changed = true;
  }
  return changed;
}

function applyReinforceEdge(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  candidatesById: Map<string, MemoryGraphEdge>,
  now: number,
): boolean {
  let changed = false;
  for (const edgeId of operation.edgeIds ?? []) {
    const existing = state.edgesById.get(edgeId);
    const candidate = candidatesById.get(edgeId);
    if (existing === undefined || candidate === undefined) {
      continue;
    }
    const merged = mergeEdge(existing, candidate, now);
    if (merged.changed) {
      state.edgesById.set(edgeId, merged.edge);
      changed = true;
    }
  }
  return changed;
}

function applyWeakenEdge(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  now: number,
): boolean {
  let changed = false;
  for (const edgeId of operation.edgeIds ?? []) {
    const edge = state.edgesById.get(edgeId);
    if (edge === undefined) {
      continue;
    }
    const reasonCodes = uniqueValues([
      ...edge.reasonCodes,
      ...operation.reasonCodes,
    ]);
    if (reasonCodes.length === edge.reasonCodes.length) {
      continue;
    }
    state.edgesById.set(edgeId, {
      ...edge,
      reasonCodes,
      metadata: mergeMetadata(edge.metadata, operation.metadata),
      updatedAt: now,
    });
    changed = true;
  }
  return changed;
}

function applyClusterLifecycle(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  now: number,
): boolean {
  const clusterId = operation.clusterId;
  if (clusterId === undefined) {
    return false;
  }

  const cluster = state.clustersById.get(clusterId);
  if (cluster === undefined) {
    return false;
  }

  const toStatus = operation.toStatus;
  const nextStatus: MemoryClusterLifecycleStatus =
    toStatus ?? cluster.lifecycleStatus;
  const representativeNodeId =
    operation.supersededByNodeId ?? cluster.representativeNodeId;
  const reasonCodes = uniqueValues([
    ...cluster.reasonCodes,
    ...operation.reasonCodes,
  ]);
  const changed =
    nextStatus !== cluster.lifecycleStatus ||
    representativeNodeId !== cluster.representativeNodeId ||
    reasonCodes.length !== cluster.reasonCodes.length;

  if (!changed) {
    return false;
  }

  state.clustersById.set(clusterId, {
    ...cluster,
    lifecycleStatus: nextStatus,
    representativeNodeId,
    reasonCodes,
    metadata: mergeMetadata(cluster.metadata, operation.metadata),
    updatedAt: now,
  });
  return true;
}

function supersededSourceNodeIds(operation: MemoryGraphOperation): string[] {
  if (operation.supersededByNodeId === undefined) {
    return operation.nodeIds;
  }
  return operation.nodeIds.filter(
    (nodeId) => nodeId !== operation.supersededByNodeId,
  );
}

function applySupersedeNode(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  now: number,
): boolean {
  const supersededByNodeId =
    operation.supersededByNodeId ?? operation.nodeIds[1];
  if (supersededByNodeId === undefined) {
    return false;
  }

  const sourceNodeIds = supersededSourceNodeIds(operation);
  const edgeIds = operation.edgeIds ?? [];
  let changed = false;

  for (const sourceNodeId of sourceNodeIds) {
    const sourceNode = scopedExistingNode(
      state,
      sourceNodeId,
      operation.ownerScope,
    );
    if (sourceNode === undefined) {
      continue;
    }

    const existingSupersededByNodeId = sourceNode.metadata?.supersededByNodeId;
    const alreadySuperseded =
      sourceNode.visibility === "deprecated" &&
      existingSupersededByNodeId === supersededByNodeId;

    mergeAuditTrail(state, operation.ownerScope, sourceNodeId, {
      sourceNodeIds: [sourceNodeId],
      edgeIds,
      operationIds: [operation.operationId],
      reasonCodes: operation.reasonCodes,
      metadata: operation.metadata,
    });
    mergeAuditTrail(state, operation.ownerScope, supersededByNodeId, {
      sourceNodeIds: [sourceNodeId],
      edgeIds,
      operationIds: [operation.operationId],
      reasonCodes: operation.reasonCodes,
      metadata: operation.metadata,
    });

    if (alreadySuperseded) {
      continue;
    }

    state.nodesById.set(sourceNodeId, {
      ...sourceNode,
      visibility: "deprecated",
      updatedAt: now,
      metadata: {
        ...(sourceNode.metadata ?? {}),
        supersededByNodeId,
        deprecatedAt: now,
        deprecationReasonCodes: uniqueValues([
          ...((sourceNode.metadata?.deprecationReasonCodes as
            | string[]
            | undefined) ?? []),
          ...operation.reasonCodes,
        ]),
      },
    });
    changed = true;
  }

  return changed;
}

function applyOperation(
  state: MutableGraphState,
  operation: MemoryGraphOperation,
  candidates: {
    nodesById: Map<string, MemoryGraphNode>;
    edgesById: Map<string, MemoryGraphEdge>;
  },
  now: number,
): boolean {
  if (operation.kind === "create-node") {
    return applyCreateNode(state, operation, candidates.nodesById);
  }
  if (operation.kind === "create-edge") {
    return applyCreateEdge(state, operation, candidates.edgesById);
  }
  if (operation.kind === "reinforce-edge") {
    return applyReinforceEdge(state, operation, candidates.edgesById, now);
  }
  if (operation.kind === "weaken-edge") {
    return applyWeakenEdge(state, operation, now);
  }
  if (
    operation.kind === "set-cluster-lifecycle" ||
    operation.kind === "set-cluster-representative"
  ) {
    return applyClusterLifecycle(state, operation, now);
  }
  if (operation.kind === "supersede-node") {
    return applySupersedeNode(state, operation, now);
  }
  return false;
}

function emptyAuditTrail(query: MemoryGraphAuditQuery): MemoryGraphAuditTrail {
  return {
    ownerScope: query.ownerScope,
    nodeId: query.nodeId,
    sourceNodeIds: [],
    edgeIds: [],
    operationIds: [],
    reasonCodes: ["audit_trail_unavailable"],
  };
}

export function createInMemoryMemoryGraphStore(
  input: CreateInMemoryMemoryGraphStoreInput = {},
): MemoryGraphStore {
  const clock = input.now ?? Date.now;
  const state = cloneSnapshot(input.snapshot ?? emptySnapshot({ userId: "" }));

  return {
    async readSnapshot(query) {
      return filterSnapshot(
        snapshotFromState(query.ownerScope, state, clock()),
        query,
      );
    },
    async persistPlan(plan) {
      if (!shouldPersist(plan)) {
        return noOpResult(plan, DEFAULT_NOOP_DIAGNOSTIC, [
          "persistence_not_enabled",
        ]);
      }

      const planScopeErrors = validatePlanScope(plan);
      if (planScopeErrors.length > 0) {
        return noOpResult(
          plan,
          "memory_graph_owner_scope_error",
          planScopeErrors,
        );
      }

      const candidates = {
        nodesById: new Map(plan.candidateNodes.map((node) => [node.id, node])),
        edgesById: new Map(plan.candidateEdges.map((edge) => [edge.id, edge])),
      };
      const appliedOperations: MemoryGraphOperation[] = [];
      const skippedOperations: MemoryGraphUpdateResult["skippedOperations"] =
        [];
      const now = clock();

      for (const operation of plan.operations) {
        if (operationScopeMismatch(operation, plan.ownerScope)) {
          skippedOperations.push({
            operation,
            reasonCodes: ["operation_owner_scope_mismatch"],
          });
          continue;
        }

        const changed = applyOperation(state, operation, candidates, now);
        if (changed) {
          appliedOperations.push(operation);
        } else {
          skippedOperations.push({
            operation,
            reasonCodes: ["operation_already_applied_or_missing_candidate"],
          });
        }
      }

      return {
        ownerScope: plan.ownerScope,
        appliedOperations,
        skippedOperations,
        mutatesGraph: appliedOperations.length > 0,
        diagnostics:
          appliedOperations.length > 0
            ? ["memory_graph_persistence_applied"]
            : ["memory_graph_persistence_no_changes"],
        metadata: plan.metadata,
      };
    },
    async readAuditTrail(query) {
      const trail = state.auditTrailsByKey.get(
        auditTrailKey(query.ownerScope, query.nodeId),
      );
      if (trail === undefined) {
        return emptyAuditTrail(query);
      }

      const sourceNodeIds = query.includeDeprecated
        ? trail.sourceNodeIds
        : trail.sourceNodeIds.filter((sourceNodeId) => {
            const sourceNode = state.nodesById.get(sourceNodeId);
            return sourceNode?.visibility !== "deprecated";
          });

      return {
        ...trail,
        sourceNodeIds,
      };
    },
  };
}
