import type {
  GraphAwareRetrievalResult,
  GraphEvolutionExplanationCategory,
  GraphEvolutionOperationExplanation,
  GraphEvolutionReport,
  GraphEvolutionSkippedSignalExplanation,
  MemoryGraphConsolidationPlan,
  MemoryGraphEdge,
  MemoryGraphOperation,
  MemoryGraphUpdatePlan,
  MemoryGraphUpdateResult,
  OwnerScope,
  ClusterLifecyclePolicyResult,
} from "./graph-contracts";
import type { MemoryGraphUpdateDryRunPlan } from "./graph-dry-run";

export interface BuildGraphEvolutionReportInput {
  reportId: string;
  generatedAt: number;
  plan: MemoryGraphUpdatePlan | MemoryGraphUpdateDryRunPlan;
  persistenceResult?: MemoryGraphUpdateResult;
  lifecycleResult?: ClusterLifecyclePolicyResult;
  consolidationPlan?: MemoryGraphConsolidationPlan;
  retrievalResult?: GraphAwareRetrievalResult;
  effects?: {
    mutatesStorage?: boolean;
    mutatesRuntime?: boolean;
    mutatesRetrieval?: boolean;
  };
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function hasDryRunDetails(
  plan: MemoryGraphUpdatePlan | MemoryGraphUpdateDryRunPlan,
): plan is MemoryGraphUpdateDryRunPlan {
  return "summary" in plan && "skippedSignals" in plan;
}

function edgesById(edges: MemoryGraphEdge[]): Map<string, MemoryGraphEdge> {
  return new Map(edges.map((edge) => [edge.id, edge]));
}

function edgeForOperation(
  operation: MemoryGraphOperation,
  candidateEdgesById: Map<string, MemoryGraphEdge>,
): MemoryGraphEdge | undefined {
  const edgeId = operation.edgeIds?.[0];
  if (edgeId === undefined) {
    return undefined;
  }
  return candidateEdgesById.get(edgeId);
}

function categoryForOperation(
  operation: MemoryGraphOperation,
  edge: MemoryGraphEdge | undefined,
): GraphEvolutionExplanationCategory {
  if (operation.kind === "create-node") {
    return "node";
  }
  if (operation.kind === "reinforce-edge") {
    return "reinforcement";
  }
  if (operation.kind === "weaken-edge") {
    return "weakening";
  }
  if (operation.kind === "supersede-node") {
    return "sedimentation";
  }
  if (operation.kind === "set-cluster-lifecycle") {
    return "lifecycle";
  }
  if (edge?.kind === "support") {
    return "reinforcement";
  }
  if (edge?.kind === "compete") {
    return "competition";
  }
  if (edge?.kind === "supersede") {
    return "sedimentation";
  }
  return "relation";
}

function summaryForOperation(
  operation: MemoryGraphOperation,
  category: GraphEvolutionExplanationCategory,
): string {
  if (operation.kind === "create-node") {
    return "New memory node would enter the graph as a candidate.";
  }
  if (operation.kind === "reinforce-edge") {
    return "Existing relation edge would be reinforced by new evidence.";
  }
  if (operation.kind === "weaken-edge") {
    return "Existing relation edge would be weakened or marked for decay.";
  }
  if (operation.kind === "supersede-node") {
    return "Source memory would be superseded by a graph representative.";
  }
  if (category === "competition") {
    return "Competing memories would be connected as conflicting alternatives.";
  }
  if (category === "sedimentation") {
    return "Supersede relation would sediment source memory behind a representative.";
  }
  if (category === "reinforcement") {
    return "Supporting relation would strengthen connected memory nodes.";
  }
  if (category === "lifecycle") {
    return "Cluster lifecycle state would change in a controlled plan.";
  }
  return "Relation observation would be added to the graph plan.";
}

function buildOperationExplanations(
  plan: MemoryGraphUpdatePlan | MemoryGraphUpdateDryRunPlan,
): GraphEvolutionOperationExplanation[] {
  const candidateEdgesById = edgesById(plan.candidateEdges);
  return plan.operations.map((operation) => {
    const edge = edgeForOperation(operation, candidateEdgesById);
    const category = categoryForOperation(operation, edge);

    return {
      operationId: operation.operationId,
      category,
      kind: operation.kind,
      nodeIds: operation.nodeIds,
      edgeIds: operation.edgeIds,
      relationKind: edge?.kind,
      supersededByNodeId: operation.supersededByNodeId,
      summary: summaryForOperation(operation, category),
      reasonCodes: operation.reasonCodes,
      metadata: operation.metadata,
    };
  });
}

function buildSkippedSignalExplanations(
  plan: MemoryGraphUpdatePlan | MemoryGraphUpdateDryRunPlan,
): GraphEvolutionSkippedSignalExplanation[] {
  if (!hasDryRunDetails(plan)) {
    return [];
  }

  return plan.skippedSignals.map((signal) => ({
    signalType: signal.signalType,
    id: signal.id,
    summary: signal.reasonCodes.includes("owner_scope_mismatch")
      ? "Signal was skipped to preserve owner scope isolation."
      : "Signal was skipped because required graph context was missing.",
    reasonCodes: signal.reasonCodes,
    metadata: signal.metadata,
  }));
}

function reasonCodesForReport(
  plan: MemoryGraphUpdatePlan | MemoryGraphUpdateDryRunPlan,
  operationExplanations: GraphEvolutionOperationExplanation[],
  skippedSignalExplanations: GraphEvolutionSkippedSignalExplanation[],
  warnings: string[],
): string[] {
  return uniqueValues([
    "graph_evolution_report",
    ...plan.reasonCodes,
    ...operationExplanations.map(
      (explanation) => `${explanation.category}_explained`,
    ),
    ...(skippedSignalExplanations.length > 0
      ? ["skipped_signals_explained"]
      : []),
    ...(warnings.length > 0 ? ["graph_evolution_report_warning"] : []),
  ]);
}

export function buildGraphEvolutionReport(
  input: BuildGraphEvolutionReportInput,
): GraphEvolutionReport {
  const operationExplanations = buildOperationExplanations(input.plan);
  const skippedSignalExplanations = buildSkippedSignalExplanations(input.plan);
  const warnings = input.warnings ?? [];
  const dryRun = input.plan.persistence.mode === "dry-run";
  const mutatesGraph = input.persistenceResult?.mutatesGraph ?? false;
  const candidateNodeCount = hasDryRunDetails(input.plan)
    ? input.plan.summary.candidateNodeCount
    : input.plan.candidateNodes.length;
  const candidateEdgeCount = hasDryRunDetails(input.plan)
    ? input.plan.summary.candidateEdgeCount
    : input.plan.candidateEdges.length;
  const skippedSignalCount = hasDryRunDetails(input.plan)
    ? input.plan.summary.skippedSignalCount
    : 0;

  return {
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    ownerScope: input.plan.ownerScope,
    summary: {
      ownerScope: input.plan.ownerScope,
      dryRun,
      mutatesGraph,
      mutatesStorage: input.effects?.mutatesStorage ?? false,
      mutatesRuntime: input.effects?.mutatesRuntime ?? false,
      mutatesRetrieval: input.effects?.mutatesRetrieval ?? false,
      operationCount: input.plan.operations.length,
      warningCount: warnings.length + skippedSignalExplanations.length,
      candidateNodeCount,
      candidateEdgeCount,
      skippedSignalCount,
      operationCounts: countBy(input.plan.operations.map((item) => item.kind)),
      explanationCounts: countBy(
        operationExplanations.map((item) => item.category),
      ),
    },
    plan: input.plan,
    persistenceResult: input.persistenceResult,
    lifecycleResult: input.lifecycleResult,
    consolidationPlan: input.consolidationPlan,
    retrievalResult: input.retrievalResult,
    operationExplanations,
    skippedSignalExplanations,
    warnings,
    reasonCodes: reasonCodesForReport(
      input.plan,
      operationExplanations,
      skippedSignalExplanations,
      warnings,
    ),
    metadata: input.metadata,
  };
}
