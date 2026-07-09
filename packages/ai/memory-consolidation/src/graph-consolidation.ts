import type {
  ClusterLifecyclePolicyResult,
  ClusterLifecycleTransition,
  MemoryClusterLifecycleStatus,
  MemoryConsolidationPlanner,
  MemoryGraphClusterSnapshot,
  MemoryGraphConsolidationInput,
  MemoryGraphConsolidationPlan,
  MemoryGraphDeprecationPlan,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphSummaryCandidate,
  OwnerScope,
} from "./graph-contracts";
import {
  buildMemoryDeprecationEntries,
  type MemoryDeprecationEntriesResult,
  type MemorySummaryCandidate,
} from "./pipeline";

export interface BuildMemoryGraphConsolidationPlanInput extends MemoryGraphConsolidationInput {
  maxSummaryCandidates?: number;
  includeDeprecatedSources?: boolean;
}

export interface BuildMemoryGraphDeprecationEntriesInput {
  persistedSummaryIds: string[];
  summaryCandidates: MemoryGraphSummaryCandidate[];
  reasonFor?: (summaryId: string) => string | undefined;
}

const SUMMARY_CANDIDATE_REASON = "stable_cluster_summary_candidate";
const SUMMARY_REPRESENTATIVE_REASON = "stable_summary_representative";
const SUPERSEDED_CLUSTER_REASON = "superseded_cluster_deprecation_candidate";
const DECAYING_CLUSTER_REASON = "decaying_cluster_archive_candidate";

function ownerScopeKey(scope: OwnerScope): string {
  return `${scope.tenantId ?? ""}|${scope.workspaceId ?? ""}|${scope.userId}`;
}

function sameOwnerScope(left: OwnerScope, right: OwnerScope): boolean {
  return ownerScopeKey(left) === ownerScopeKey(right);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function numberFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function scopedNodesById(
  nodes: MemoryGraphNode[],
  ownerScope: OwnerScope,
): Map<string, MemoryGraphNode> {
  return new Map(
    nodes
      .filter((node) => sameOwnerScope(node.ownerScope, ownerScope))
      .map((node) => [node.id, node]),
  );
}

function transitionByClusterId(
  lifecycle: ClusterLifecyclePolicyResult,
): Map<string, ClusterLifecycleTransition> {
  return new Map(
    lifecycle.transitions.map((transition) => [
      transition.clusterId,
      transition,
    ]),
  );
}

function scopedClusters(
  clusters: MemoryGraphClusterSnapshot[],
  ownerScope: OwnerScope,
): MemoryGraphClusterSnapshot[] {
  return clusters.filter((cluster) =>
    sameOwnerScope(cluster.ownerScope, ownerScope),
  );
}

function finalStatusForCluster(
  cluster: MemoryGraphClusterSnapshot,
  transition: ClusterLifecycleTransition | undefined,
): MemoryClusterLifecycleStatus {
  return transition?.toStatus ?? cluster.lifecycleStatus;
}

function clusterNodeIds(
  cluster: MemoryGraphClusterSnapshot,
  nodesById: Map<string, MemoryGraphNode>,
): string[] {
  return cluster.nodeIds.filter((nodeId) => nodesById.has(nodeId));
}

function sourceNodeIdsForCluster(
  cluster: MemoryGraphClusterSnapshot,
  nodesById: Map<string, MemoryGraphNode>,
  includeDeprecatedSources: boolean,
): string[] {
  return clusterNodeIds(cluster, nodesById).filter((nodeId) => {
    const node = nodesById.get(nodeId);
    if (node?.type !== "raw") {
      return false;
    }
    if (node.visibility === "default") {
      return true;
    }
    return includeDeprecatedSources && node.visibility === "deprecated";
  });
}

function visibleRawNodeIdsForCluster(
  cluster: MemoryGraphClusterSnapshot,
  nodesById: Map<string, MemoryGraphNode>,
): string[] {
  return clusterNodeIds(cluster, nodesById).filter((nodeId) => {
    const node = nodesById.get(nodeId);
    return node?.type === "raw" && node.visibility === "default";
  });
}

function scopedSupersedeEdges(
  edges: MemoryGraphEdge[],
  ownerScope: OwnerScope,
): MemoryGraphEdge[] {
  return edges.filter(
    (edge) =>
      edge.kind === "supersede" && sameOwnerScope(edge.ownerScope, ownerScope),
  );
}

function representativeFromSupersedeEdge(
  cluster: MemoryGraphClusterSnapshot,
  edges: MemoryGraphEdge[],
  nodesById: Map<string, MemoryGraphNode>,
): string | undefined {
  const nodeIds = new Set(clusterNodeIds(cluster, nodesById));
  return [...edges]
    .filter(
      (edge) =>
        nodeIds.has(edge.fromNodeId) &&
        nodeIds.has(edge.toNodeId) &&
        nodesById.has(edge.toNodeId),
    )
    .sort((a, b) => b.weight - a.weight)[0]?.toNodeId;
}

function representativeNodeId(
  cluster: MemoryGraphClusterSnapshot,
  transition: ClusterLifecycleTransition | undefined,
  edges: MemoryGraphEdge[],
  nodesById: Map<string, MemoryGraphNode>,
): string | undefined {
  return (
    transition?.representativeNodeId ??
    cluster.representativeNodeId ??
    representativeFromSupersedeEdge(cluster, edges, nodesById)
  );
}

function representativeIsSummaryLike(
  nodeId: string | undefined,
  nodesById: Map<string, MemoryGraphNode>,
): nodeId is string {
  const node = nodeId === undefined ? undefined : nodesById.get(nodeId);
  return node?.type === "summary" || node?.type === "artifact";
}

function clusterReasonCodes(
  reason: string,
  cluster: MemoryGraphClusterSnapshot,
  transition: ClusterLifecycleTransition | undefined,
  lifecycle: ClusterLifecyclePolicyResult,
): string[] {
  return uniqueValues([
    reason,
    ...cluster.reasonCodes,
    ...(transition?.reasonCodes ?? []),
    ...lifecycle.reasonCodes,
  ]);
}

function competitionKeyForCluster(cluster: MemoryGraphClusterSnapshot): string {
  return (
    stringFromMetadata(cluster.metadata, "competitionKey") ?? cluster.clusterId
  );
}

function summaryCandidateId(clusterId: string): string {
  return `summary-candidate:${encodeURIComponent(clusterId)}`;
}

function buildSummaryCandidate(input: {
  ownerScope: OwnerScope;
  cluster: MemoryGraphClusterSnapshot;
  transition: ClusterLifecycleTransition | undefined;
  lifecycle: ClusterLifecyclePolicyResult;
  sourceNodeIds: string[];
  representativeNodeId?: string;
  now: number;
}): MemoryGraphSummaryCandidate {
  const supportScore = input.cluster.supportScore ?? input.sourceNodeIds.length;
  return {
    candidateId: summaryCandidateId(input.cluster.clusterId),
    ownerScope: input.ownerScope,
    clusterId: input.cluster.clusterId,
    sourceNodeIds: input.sourceNodeIds,
    representativeNodeId: input.representativeNodeId,
    reasonCodes: clusterReasonCodes(
      SUMMARY_CANDIDATE_REASON,
      input.cluster,
      input.transition,
      input.lifecycle,
    ),
    metadata: {
      competitionKey: competitionKeyForCluster(input.cluster),
      evidenceCount: input.sourceNodeIds.length,
      generatedAt: input.now,
      lifecycleStatus: finalStatusForCluster(input.cluster, input.transition),
      supportScore,
    },
  };
}

function buildDeprecationPlan(input: {
  ownerScope: OwnerScope;
  cluster: MemoryGraphClusterSnapshot;
  transition: ClusterLifecycleTransition | undefined;
  lifecycle: ClusterLifecyclePolicyResult;
  sourceNodeIds: string[];
  supersededByNodeId: string;
  reason: string;
}): MemoryGraphDeprecationPlan {
  return {
    ownerScope: input.ownerScope,
    sourceNodeIds: input.sourceNodeIds,
    supersededByNodeId: input.supersededByNodeId,
    reasonCodes: clusterReasonCodes(
      input.reason,
      input.cluster,
      input.transition,
      input.lifecycle,
    ),
    metadata: {
      clusterId: input.cluster.clusterId,
      competitionKey: competitionKeyForCluster(input.cluster),
      lifecycleStatus: finalStatusForCluster(input.cluster, input.transition),
    },
  };
}

function compareSummaryCandidates(
  left: MemoryGraphSummaryCandidate,
  right: MemoryGraphSummaryCandidate,
): number {
  const leftScore = numberFromMetadata(left.metadata, "supportScore") ?? 0;
  const rightScore = numberFromMetadata(right.metadata, "supportScore") ?? 0;
  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }
  return right.sourceNodeIds.length - left.sourceNodeIds.length;
}

export function buildMemoryGraphConsolidationPlan(
  input: BuildMemoryGraphConsolidationPlanInput,
): MemoryGraphConsolidationPlan {
  const nodesById = scopedNodesById(input.snapshot.nodes, input.ownerScope);
  const transitionsByClusterId = transitionByClusterId(input.lifecycle);
  const supersedeEdges = scopedSupersedeEdges(
    input.snapshot.edges,
    input.ownerScope,
  );
  const eligibleClusterIds = new Set(
    input.lifecycle.consolidationEligibleClusterIds,
  );
  const summaryCandidates: MemoryGraphSummaryCandidate[] = [];
  const deprecationPlans: MemoryGraphDeprecationPlan[] = [];
  const archiveCandidateNodeIds: string[] = [];
  const preserveClusterIds: string[] = [];
  const reasonCodes = new Set<string>(["graph_consolidation_plan_created"]);

  for (const cluster of scopedClusters(
    input.snapshot.clusters,
    input.ownerScope,
  )) {
    const transition = transitionsByClusterId.get(cluster.clusterId);
    const finalStatus = finalStatusForCluster(cluster, transition);
    const representative = representativeNodeId(
      cluster,
      transition,
      supersedeEdges,
      nodesById,
    );
    const sourceNodeIds = sourceNodeIdsForCluster(
      cluster,
      nodesById,
      input.includeDeprecatedSources ?? false,
    ).filter((nodeId) => nodeId !== representative);
    const visibleSourceNodeIds = visibleRawNodeIdsForCluster(
      cluster,
      nodesById,
    ).filter((nodeId) => nodeId !== representative);

    if (
      (eligibleClusterIds.has(cluster.clusterId) || finalStatus === "stable") &&
      sourceNodeIds.length > 0
    ) {
      if (representativeIsSummaryLike(representative, nodesById)) {
        deprecationPlans.push(
          buildDeprecationPlan({
            ownerScope: input.ownerScope,
            cluster,
            transition,
            lifecycle: input.lifecycle,
            sourceNodeIds: visibleSourceNodeIds,
            supersededByNodeId: representative,
            reason: SUMMARY_REPRESENTATIVE_REASON,
          }),
        );
        reasonCodes.add(SUMMARY_REPRESENTATIVE_REASON);
      } else {
        summaryCandidates.push(
          buildSummaryCandidate({
            ownerScope: input.ownerScope,
            cluster,
            transition,
            lifecycle: input.lifecycle,
            sourceNodeIds,
            representativeNodeId: representative,
            now: input.now,
          }),
        );
        reasonCodes.add(SUMMARY_CANDIDATE_REASON);
      }
      continue;
    }

    if (
      finalStatus === "superseded" &&
      representativeIsSummaryLike(representative, nodesById) &&
      visibleSourceNodeIds.length > 0
    ) {
      deprecationPlans.push(
        buildDeprecationPlan({
          ownerScope: input.ownerScope,
          cluster,
          transition,
          lifecycle: input.lifecycle,
          sourceNodeIds: visibleSourceNodeIds,
          supersededByNodeId: representative,
          reason: SUPERSEDED_CLUSTER_REASON,
        }),
      );
      reasonCodes.add(SUPERSEDED_CLUSTER_REASON);
      continue;
    }

    if (finalStatus === "decaying" && visibleSourceNodeIds.length > 0) {
      archiveCandidateNodeIds.push(...visibleSourceNodeIds);
      reasonCodes.add(DECAYING_CLUSTER_REASON);
      continue;
    }

    preserveClusterIds.push(cluster.clusterId);
  }

  return {
    ownerScope: input.ownerScope,
    summaryCandidates: summaryCandidates
      .sort(compareSummaryCandidates)
      .slice(
        0,
        Math.max(1, input.maxSummaryCandidates ?? summaryCandidates.length),
      ),
    deprecationPlans,
    archiveCandidateNodeIds: uniqueValues(archiveCandidateNodeIds),
    preserveClusterIds: uniqueValues(preserveClusterIds),
    reasonCodes: [...reasonCodes],
    metadata: input.metadata,
  };
}

export function createMemoryGraphConsolidationPlanner(
  options: Omit<
    BuildMemoryGraphConsolidationPlanInput,
    "ownerScope" | "snapshot" | "lifecycle" | "now" | "metadata"
  > = {},
): MemoryConsolidationPlanner {
  return {
    async plan(input) {
      return buildMemoryGraphConsolidationPlan({
        ...options,
        ...input,
      });
    },
  };
}

export function graphSummaryCandidateToMemorySummaryCandidate(
  candidate: MemoryGraphSummaryCandidate,
): MemorySummaryCandidate {
  const evidenceCount =
    numberFromMetadata(candidate.metadata, "evidenceCount") ??
    candidate.sourceNodeIds.length;
  const score = numberFromMetadata(candidate.metadata, "supportScore") ?? 1;
  return {
    clusterKey: candidate.clusterId,
    competitionKey:
      stringFromMetadata(candidate.metadata, "competitionKey") ??
      candidate.clusterId,
    recordIds: candidate.sourceNodeIds,
    evidenceCount,
    score,
    priority: score * Math.log1p(evidenceCount),
    reasonCodes: ["strong_repeated_evidence"],
    sourceAction: "preserve",
  };
}

export function buildMemoryGraphDeprecationEntries(
  input: BuildMemoryGraphDeprecationEntriesInput,
): MemoryDeprecationEntriesResult {
  return buildMemoryDeprecationEntries({
    persistedSummaryIds: input.persistedSummaryIds,
    summaryCandidates: input.summaryCandidates.map(
      graphSummaryCandidateToMemorySummaryCandidate,
    ),
    reasonFor: input.reasonFor,
  });
}
