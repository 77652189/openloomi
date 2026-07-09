import type {
  ClusterLifecyclePolicyResult,
  ClusterLifecycleTransition,
  MemoryClusterLifecycleStatus,
  MemoryGraphClusterSnapshot,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphSnapshot,
  OwnerScope,
} from "./graph-contracts";

export interface MemoryClusterLifecycleDryRunThresholds {
  activeSupportEdgeCount?: number;
  activeSupportScore?: number;
  stableSupportEdgeCount?: number;
  stableSupportScore?: number;
  decayingSupportScore?: number;
  staleAfterMs?: number;
  competeWeight?: number;
  supersedeWeight?: number;
}

export interface MemoryClusterLifecycleAnalysis {
  ownerScope: OwnerScope;
  clusterId: string;
  fromStatus: MemoryClusterLifecycleStatus;
  toStatus: MemoryClusterLifecycleStatus;
  supportEdgeCount: number;
  competeEdgeCount: number;
  supersedeEdgeCount: number;
  supportScore: number;
  stale: boolean;
  representativeNodeId?: string;
  reasonCodes: string[];
}

export interface MemoryClusterLifecycleDryRunSummary {
  clusterCount: number;
  transitionCount: number;
  consolidationEligibleClusterCount: number;
  auditOnlyClusterCount: number;
  skippedClusterCount: number;
  mutatesGraph: false;
  persistenceEnabled: false;
  statusCounts: Record<string, number>;
}

export interface MemoryClusterLifecycleDryRunResult extends ClusterLifecyclePolicyResult {
  summary: MemoryClusterLifecycleDryRunSummary;
  analyses: MemoryClusterLifecycleAnalysis[];
  skippedClusterIds: string[];
}

export interface BuildMemoryClusterLifecycleDryRunInput {
  ownerScope: OwnerScope;
  snapshot: MemoryGraphSnapshot;
  now: number;
  thresholds?: MemoryClusterLifecycleDryRunThresholds;
  metadata?: Record<string, unknown>;
}

interface ResolvedThresholds {
  activeSupportEdgeCount: number;
  activeSupportScore: number;
  stableSupportEdgeCount: number;
  stableSupportScore: number;
  decayingSupportScore: number;
  staleAfterMs: number;
  competeWeight: number;
  supersedeWeight: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveThresholds(
  thresholds: MemoryClusterLifecycleDryRunThresholds = {},
): ResolvedThresholds {
  return {
    activeSupportEdgeCount: thresholds.activeSupportEdgeCount ?? 1,
    activeSupportScore: thresholds.activeSupportScore ?? 0.45,
    stableSupportEdgeCount: thresholds.stableSupportEdgeCount ?? 2,
    stableSupportScore: thresholds.stableSupportScore ?? 0.75,
    decayingSupportScore: thresholds.decayingSupportScore ?? 0.25,
    staleAfterMs: thresholds.staleAfterMs ?? 45 * DAY_MS,
    competeWeight: thresholds.competeWeight ?? 0.7,
    supersedeWeight: thresholds.supersedeWeight ?? 0.8,
  };
}

function ownerScopeKey(scope: OwnerScope): string {
  return `${scope.tenantId ?? ""}|${scope.workspaceId ?? ""}|${scope.userId}`;
}

function sameOwnerScope(left: OwnerScope, right: OwnerScope): boolean {
  return ownerScopeKey(left) === ownerScopeKey(right);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function edgeTouchesCluster(
  edge: MemoryGraphEdge,
  nodeIds: Set<string>,
): boolean {
  return nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId);
}

function edgeInsideCluster(
  edge: MemoryGraphEdge,
  nodeIds: Set<string>,
): boolean {
  return nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId);
}

function clusterNodes(
  cluster: MemoryGraphClusterSnapshot,
  nodesById: Map<string, MemoryGraphNode>,
): MemoryGraphNode[] {
  return cluster.nodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is MemoryGraphNode => node !== undefined);
}

function allNodesHiddenFromDefault(nodes: MemoryGraphNode[]): boolean {
  return (
    nodes.length > 0 && nodes.every((node) => node.visibility !== "default")
  );
}

function supportScore(
  cluster: MemoryGraphClusterSnapshot,
  supportEdges: MemoryGraphEdge[],
): number {
  return (
    cluster.supportScore ?? average(supportEdges.map((edge) => edge.weight))
  );
}

function representativeFromSupersede(
  supersedeEdges: MemoryGraphEdge[],
): string | undefined {
  return supersedeEdges[0]?.toNodeId;
}

function analyzeCluster(
  cluster: MemoryGraphClusterSnapshot,
  edges: MemoryGraphEdge[],
  nodesById: Map<string, MemoryGraphNode>,
  input: BuildMemoryClusterLifecycleDryRunInput,
  thresholds: ResolvedThresholds,
): MemoryClusterLifecycleAnalysis {
  const nodeIds = new Set(cluster.nodeIds);
  const supportEdges = edges.filter(
    (edge) => edge.kind === "support" && edgeInsideCluster(edge, nodeIds),
  );
  const competeEdges = edges.filter(
    (edge) =>
      edge.kind === "compete" &&
      edgeTouchesCluster(edge, nodeIds) &&
      edge.weight >= thresholds.competeWeight,
  );
  const supersedeEdges = edges.filter(
    (edge) =>
      edge.kind === "supersede" &&
      edgeTouchesCluster(edge, nodeIds) &&
      edge.weight >= thresholds.supersedeWeight,
  );
  const score = supportScore(cluster, supportEdges);
  const stale = input.now - cluster.updatedAt >= thresholds.staleAfterMs;
  const nodes = clusterNodes(cluster, nodesById);
  const allHidden = allNodesHiddenFromDefault(nodes);
  const representativeNodeId =
    representativeFromSupersede(supersedeEdges) ?? cluster.representativeNodeId;
  const fromStatus = cluster.lifecycleStatus;
  let toStatus = fromStatus;
  const reasonCodes: string[] = [];

  if (fromStatus === "audit-only") {
    reasonCodes.push("cluster_already_audit_only");
  } else if (fromStatus === "superseded" && allHidden) {
    toStatus = "audit-only";
    reasonCodes.push("superseded_cluster_hidden_from_default");
  } else if (supersedeEdges.length > 0) {
    toStatus = "superseded";
    reasonCodes.push("supersede_relation_observed", "summary_sedimentation");
  } else if (competeEdges.length > 0) {
    toStatus = "decaying";
    reasonCodes.push("strong_competition_observed");
  } else if (
    stale &&
    (score <= thresholds.decayingSupportScore || supportEdges.length === 0)
  ) {
    toStatus = "decaying";
    reasonCodes.push("stale_or_unsupported_cluster");
  } else if (
    (fromStatus === "forming" || fromStatus === "active") &&
    supportEdges.length >= thresholds.stableSupportEdgeCount &&
    score >= thresholds.stableSupportScore
  ) {
    toStatus = "stable";
    reasonCodes.push("stable_support_threshold_met");
  } else if (
    fromStatus === "forming" &&
    (supportEdges.length >= thresholds.activeSupportEdgeCount ||
      score >= thresholds.activeSupportScore)
  ) {
    toStatus = "active";
    reasonCodes.push("support_deepened_cluster");
  } else if (
    fromStatus === "decaying" &&
    !stale &&
    score >= thresholds.activeSupportScore
  ) {
    toStatus = "active";
    reasonCodes.push("support_reactivated_cluster");
  } else {
    reasonCodes.push("lifecycle_unchanged");
  }

  return {
    ownerScope: input.ownerScope,
    clusterId: cluster.clusterId,
    fromStatus,
    toStatus,
    supportEdgeCount: supportEdges.length,
    competeEdgeCount: competeEdges.length,
    supersedeEdgeCount: supersedeEdges.length,
    supportScore: score,
    stale,
    representativeNodeId,
    reasonCodes: uniqueValues(reasonCodes),
  };
}

function transitionFromAnalysis(
  analysis: MemoryClusterLifecycleAnalysis,
): ClusterLifecycleTransition | undefined {
  if (analysis.fromStatus === analysis.toStatus) {
    return undefined;
  }

  return {
    ownerScope: analysis.ownerScope,
    clusterId: analysis.clusterId,
    fromStatus: analysis.fromStatus,
    toStatus: analysis.toStatus,
    representativeNodeId: analysis.representativeNodeId,
    reasonCodes: analysis.reasonCodes,
  };
}

export function buildMemoryClusterLifecycleDryRun(
  input: BuildMemoryClusterLifecycleDryRunInput,
): MemoryClusterLifecycleDryRunResult {
  const thresholds = resolveThresholds(input.thresholds);
  const nodesById = new Map(
    input.snapshot.nodes.map((node) => [node.id, node]),
  );
  const scopedEdges = input.snapshot.edges.filter((edge) =>
    sameOwnerScope(edge.ownerScope, input.ownerScope),
  );
  const scopedClusters = input.snapshot.clusters.filter((cluster) =>
    sameOwnerScope(cluster.ownerScope, input.ownerScope),
  );
  const skippedClusterIds = input.snapshot.clusters
    .filter((cluster) => !sameOwnerScope(cluster.ownerScope, input.ownerScope))
    .map((cluster) => cluster.clusterId);
  const analyses = scopedClusters.map((cluster) =>
    analyzeCluster(cluster, scopedEdges, nodesById, input, thresholds),
  );
  const transitions = analyses
    .map(transitionFromAnalysis)
    .filter(
      (transition): transition is ClusterLifecycleTransition =>
        transition !== undefined,
    );
  const consolidationEligibleClusterIds = analyses
    .filter((analysis) => analysis.toStatus === "stable")
    .map((analysis) => analysis.clusterId);
  const auditOnlyClusterIds = analyses
    .filter((analysis) => analysis.toStatus === "audit-only")
    .map((analysis) => analysis.clusterId);
  const reasonCodes = uniqueValues([
    "cluster_lifecycle_dry_run",
    "persistence_disabled",
    ...analyses.flatMap((analysis) => analysis.reasonCodes),
    ...(skippedClusterIds.length > 0 ? ["owner_scope_cluster_skipped"] : []),
  ]);

  return {
    ownerScope: input.ownerScope,
    transitions,
    consolidationEligibleClusterIds,
    auditOnlyClusterIds,
    reasonCodes,
    metadata: input.metadata,
    analyses,
    skippedClusterIds,
    summary: {
      clusterCount: scopedClusters.length,
      transitionCount: transitions.length,
      consolidationEligibleClusterCount: consolidationEligibleClusterIds.length,
      auditOnlyClusterCount: auditOnlyClusterIds.length,
      skippedClusterCount: skippedClusterIds.length,
      mutatesGraph: false,
      persistenceEnabled: false,
      statusCounts: countBy(analyses.map((analysis) => analysis.toStatus)),
    },
  };
}
