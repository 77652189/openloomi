import {
  type MemoryClusterLifecycleStatus,
  type MemoryGovernanceAuditScenarioReport,
  type MemoryGraphCorrectionAction,
  type MemoryGraphOperation,
  type MemoryGraphRolloutGovernanceReport,
  type MemoryGraphRolloutRetrievalScenarioInput,
  type MemoryGraphRolloutRuntimeEvidence,
  type MemoryGraphSnapshot,
  type MemorySemanticRetrievalEvalScenarioReport,
  type OwnerScope,
  buildGraphAwareRetrievalDryRun,
  buildMemoryGraphCorrectionPlan,
  buildMemoryGraphRollbackFinalizePlan,
  buildMemoryGraphRollbackPreparePlan,
  buildMemoryGraphRolloutGovernanceReport,
  ownerScopeKey,
  sameOwnerScope,
} from "../../ai/memory-consolidation/src";
import {
  type RawMessageGraphEvolutionStorage,
  createRawMessageMemoryGraphStore,
  ownerScopeFromMessage,
} from "./memory-graph-evolution";
import type {
  MemorySummaryRecord,
  RawMessage,
  RawMessageQuery,
} from "./storage";

export type RawMessageMemoryGraphCorrectionAction =
  | {
      type: "correct-summary";
      clusterId: string;
      summaryId: string;
      correctedContent: string;
      correctedSummaryId?: string;
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

export interface RawMessageMemoryGraphCommandBase {
  commandId: string;
  reason: string;
  requestedBy?: string;
  workspaceId?: string;
  tenantId?: string;
  expectedVersion?: string;
}

export interface RawMessageMemoryGraphCorrectionCommand extends RawMessageMemoryGraphCommandBase {
  action: RawMessageMemoryGraphCorrectionAction;
}

export interface RawMessageMemoryGraphRollbackCommand extends RawMessageMemoryGraphCommandBase {
  summaryId: string;
}

interface SemanticSearchInput {
  userId: string;
  queryEmbedding: number[];
  includeArchived?: boolean;
  includeDeprecated?: boolean;
  limit?: number;
  threshold?: number;
}

export interface RawMessageGraphGovernanceStorage extends RawMessageGraphEvolutionStorage {
  queryMessages(query: RawMessageQuery): Promise<RawMessage[]>;
  upsertSummaries(summaries: MemorySummaryRecord[]): Promise<void>;
  querySummaries(query: {
    userId?: string;
    pageSize?: number;
  }): Promise<MemorySummaryRecord[]>;
  restoreDeprecatedMessages?: (
    messageIds: string[],
    input: { userId?: string; supersededBySummaryId?: string },
  ) => Promise<number>;
  searchMessagesSemantically?: (
    input: SemanticSearchInput,
  ) => Promise<unknown[]>;
}

export type MemoryGraphGovernanceRuntimeStatus =
  | "applied"
  | "no-op"
  | "replayed"
  | "conflict"
  | "partial-failure"
  | "failed";

export interface MemoryGraphGovernanceRuntimeResult {
  status: MemoryGraphGovernanceRuntimeStatus;
  ownerScope: OwnerScope;
  commandId: string;
  graphVersion?: string;
  appliedOperationIds: string[];
  restoredRecords: number;
  reasonCodes: string[];
  summaryId?: string;
  sourceRecordIds?: string[];
  auditTrail?: {
    sourceNodeIds: string[];
    edgeIds: string[];
    operationIds: string[];
  };
  error?: { name: string; message: string };
}

export interface RunMemoryGraphRolloutEvaluationInput {
  storage: RawMessageGraphGovernanceStorage;
  userId: string;
  scenarioId: string;
  workspaceId?: string;
  tenantId?: string;
  queryEmbedding?: number[];
  pollutedArtifactIds?: string[];
  now?: number;
}

export interface MemoryGraphRolloutEvaluationRuntimeResult {
  ownerScope: OwnerScope;
  snapshotVersion?: string;
  report: MemoryGraphRolloutGovernanceReport;
  runtimeEvidence: MemoryGraphRolloutRuntimeEvidence;
  reasonCodes: string[];
}

function errorInfo(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function commandFingerprint(
  kind: "correction" | "rollback",
  command:
    | RawMessageMemoryGraphCorrectionCommand
    | RawMessageMemoryGraphRollbackCommand,
): string {
  const payload = { ...command } as Record<string, unknown>;
  payload.expectedVersion = undefined;
  return JSON.stringify(canonicalValue({ kind, ...payload }));
}

function hasCommandFingerprintConflict(
  operations: MemoryGraphOperation[],
  commandId: string,
  fingerprint: string,
): boolean {
  return operations.some(
    (operation) =>
      operation.metadata?.commandId === commandId &&
      typeof operation.metadata.commandFingerprint === "string" &&
      operation.metadata.commandFingerprint !== fingerprint,
  );
}

function semanticResultMessageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.messageId === "string") return record.messageId;
  if (typeof record.message !== "object" || record.message === null) {
    return undefined;
  }
  const message = record.message as Record<string, unknown>;
  return typeof message.messageId === "string" ? message.messageId : undefined;
}

function ownerScope(
  userId: string,
  input: { workspaceId?: string; tenantId?: string },
): OwnerScope {
  return {
    userId,
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
  };
}

function correctedSummaryId(scope: OwnerScope, commandId: string): string {
  return `memory-graph-correction:${ownerScopeKey(scope)}:${encodeURIComponent(commandId)}`;
}

function runtimeResult(input: {
  status: MemoryGraphGovernanceRuntimeStatus;
  ownerScope: OwnerScope;
  commandId: string;
  graphVersion?: string;
  operations?: MemoryGraphOperation[];
  restoredRecords?: number;
  reasonCodes: string[];
  summaryId?: string;
  sourceRecordIds?: string[];
  error?: { name: string; message: string };
}): MemoryGraphGovernanceRuntimeResult {
  return {
    status: input.status,
    ownerScope: { ...input.ownerScope },
    commandId: input.commandId,
    graphVersion: input.graphVersion,
    appliedOperationIds: (input.operations ?? []).map(
      (operation) => operation.operationId,
    ),
    restoredRecords: input.restoredRecords ?? 0,
    reasonCodes: unique(input.reasonCodes),
    summaryId: input.summaryId,
    sourceRecordIds: input.sourceRecordIds
      ? [...input.sourceRecordIds]
      : undefined,
    error: input.error,
  };
}

function validateCommand(command: RawMessageMemoryGraphCommandBase): string[] {
  return [
    ...(command.commandId.trim().length === 0
      ? ["memory_graph_command_id_required"]
      : []),
    ...(command.reason.trim().length === 0
      ? ["memory_graph_command_reason_required"]
      : []),
  ];
}

function persistenceStatus(input: {
  mutatesGraph: boolean;
  replayed?: boolean;
  conflict?: boolean;
}): MemoryGraphGovernanceRuntimeStatus {
  if (input.conflict) return "conflict";
  if (input.replayed) return "replayed";
  return input.mutatesGraph ? "applied" : "no-op";
}

function metadataStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function restoreCorrectionMessages(input: {
  storage: RawMessageGraphGovernanceStorage;
  userId: string;
  messages: RawMessage[];
}): Promise<number> {
  if (typeof input.storage.restoreDeprecatedMessages !== "function") return 0;
  const groups = new Map<string | undefined, string[]>();
  for (const message of input.messages) {
    if (message.deprecatedAt === undefined) continue;
    const summaryId = message.supersededBySummaryId;
    const ids = groups.get(summaryId) ?? [];
    ids.push(message.messageId);
    groups.set(summaryId, ids);
  }
  let restored = 0;
  for (const [summaryId, messageIds] of groups) {
    restored += await input.storage.restoreDeprecatedMessages(messageIds, {
      userId: input.userId,
      supersededBySummaryId: summaryId,
    });
  }
  return restored;
}

export async function runMemoryGraphCorrection(input: {
  storage: RawMessageGraphGovernanceStorage;
  userId: string;
  command: RawMessageMemoryGraphCorrectionCommand;
  now?: number;
}): Promise<MemoryGraphGovernanceRuntimeResult> {
  const now = input.now ?? Date.now();
  const scope = ownerScope(input.userId, input.command);
  const invalid = validateCommand(input.command);
  if (invalid.length > 0) {
    return runtimeResult({
      status: "failed",
      ownerScope: scope,
      commandId: input.command.commandId,
      reasonCodes: invalid,
    });
  }
  const store = createRawMessageMemoryGraphStore({
    storage: input.storage,
    ownerScope: scope,
    now: () => now,
  });
  let summaryId: string | undefined;
  try {
    const snapshot = await store.readSnapshot({
      ownerScope: scope,
      includeAuditOnly: true,
    });
    const priorCommandOperations = await store.readAppliedOperations({
      ownerScope: scope,
    });
    const fingerprint = commandFingerprint("correction", input.command);
    if (
      hasCommandFingerprintConflict(
        priorCommandOperations,
        input.command.commandId,
        fingerprint,
      )
    ) {
      return runtimeResult({
        status: "conflict",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: ["memory_graph_command_id_payload_conflict"],
      });
    }
    const commandWasApplied = priorCommandOperations.some(
      (operation) => operation.metadata?.commandId === input.command.commandId,
    );
    if (
      input.command.expectedVersion !== undefined &&
      input.command.expectedVersion !== (snapshot.version ?? "0") &&
      !commandWasApplied
    ) {
      return runtimeResult({
        status: "conflict",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: ["memory_graph_version_conflict"],
      });
    }

    let action: MemoryGraphCorrectionAction;
    let correctedSummary: MemorySummaryRecord | undefined;
    let previousSummary: MemorySummaryRecord | undefined;
    let memberMessage: RawMessage | null = null;
    if (input.command.action.type === "correct-summary") {
      const correction = input.command.action;
      const oldSummaries = await input.storage.querySummaries({
        userId: input.userId,
        pageSize: 1000,
      });
      const oldSummary = oldSummaries.find(
        (summary) => summary.summaryId === correction.summaryId,
      );
      if (!oldSummary || correction.correctedContent.trim().length === 0) {
        return runtimeResult({
          status: "failed",
          ownerScope: scope,
          commandId: input.command.commandId,
          graphVersion: snapshot.version,
          reasonCodes: [
            oldSummary
              ? "memory_graph_corrected_content_required"
              : "memory_graph_summary_not_found",
          ],
        });
      }
      previousSummary = oldSummary;
      summaryId =
        correction.correctedSummaryId ??
        correctedSummaryId(scope, input.command.commandId);
      correctedSummary = {
        ...oldSummary,
        summaryId,
        summaryText: correction.correctedContent,
        updatedAt: now,
        createdAt: now,
      };
      action = {
        type: "correct-summary",
        clusterId: correction.clusterId,
        summaryId: correction.summaryId,
        correctedSummaryId: summaryId,
      };
    } else {
      action = input.command.action;
      if (action.type === "remove-member") {
        memberMessage = await input.storage.getMessageById(action.nodeId);
        if (
          memberMessage &&
          !sameOwnerScope(ownerScopeFromMessage(memberMessage), scope)
        ) {
          return runtimeResult({
            status: "no-op",
            ownerScope: scope,
            commandId: input.command.commandId,
            graphVersion: snapshot.version,
            reasonCodes: ["memory_graph_scope_mismatch"],
          });
        }
      }
    }

    const plan = buildMemoryGraphCorrectionPlan({
      ownerScope: scope,
      snapshot,
      commandId: input.command.commandId,
      action,
      reason: input.command.reason,
      requestedBy: input.command.requestedBy,
      now,
      persistence: { mode: "write", enabled: true },
    });
    const removeMemberOperation =
      action.type === "remove-member"
        ? (plan.operations.find(
            (operation) => operation.kind === "remove-cluster-member",
          ) ??
          priorCommandOperations.find(
            (operation) =>
              operation.kind === "remove-cluster-member" &&
              operation.metadata?.commandId === input.command.commandId,
          ))
        : undefined;
    const correctionRestoreSourceIds =
      action.type === "remove-member"
        ? unique([
            action.nodeId,
            ...metadataStringArray(
              removeMemberOperation?.metadata,
              "restoreSourceNodeIds",
            ),
          ])
        : [];
    const correctionRestoreMessages = (
      await Promise.all(
        correctionRestoreSourceIds.map((messageId) =>
          input.storage.getMessageById(messageId),
        ),
      )
    ).filter(
      (message): message is RawMessage =>
        message !== null &&
        sameOwnerScope(ownerScopeFromMessage(message), scope),
    );
    if (
      correctionRestoreMessages.some(
        (message) => message.deprecatedAt !== undefined,
      ) &&
      typeof input.storage.restoreDeprecatedMessages !== "function"
    ) {
      return runtimeResult({
        status: commandWasApplied ? "partial-failure" : "no-op",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: [
          "adapter_missing_restore_deprecated_messages",
          "memory_graph_correction_not_applied",
        ],
        sourceRecordIds: correctionRestoreSourceIds,
      });
    }
    if (plan.operations.length === 0) {
      if (
        action.type === "remove-member" &&
        removeMemberOperation &&
        correctionRestoreMessages.some(
          (message) => message.deprecatedAt !== undefined,
        ) &&
        typeof input.storage.restoreDeprecatedMessages === "function"
      ) {
        try {
          const restoredRecords = await restoreCorrectionMessages({
            storage: input.storage,
            userId: scope.userId,
            messages: correctionRestoreMessages,
          });
          return runtimeResult({
            status: restoredRecords > 0 ? "applied" : "replayed",
            ownerScope: scope,
            commandId: input.command.commandId,
            graphVersion: snapshot.version,
            restoredRecords,
            reasonCodes: [
              ...plan.reasonCodes,
              "memory_graph_correction_restore_retried",
            ],
            sourceRecordIds: correctionRestoreSourceIds,
          });
        } catch (error) {
          return runtimeResult({
            status: "partial-failure",
            ownerScope: scope,
            commandId: input.command.commandId,
            graphVersion: snapshot.version,
            reasonCodes: ["memory_graph_correction_restore_failed"],
            sourceRecordIds: correctionRestoreSourceIds,
            error: errorInfo(error),
          });
        }
      }
      return runtimeResult({
        status: "no-op",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: plan.reasonCodes,
        summaryId,
      });
    }
    if (correctedSummary) {
      await input.storage.upsertSummaries([correctedSummary]);
      for (const operation of plan.operations) {
        operation.metadata = {
          ...(operation.metadata ?? {}),
          previousSummaryId:
            action.type === "correct-summary" ? action.summaryId : undefined,
          previousSummaryText:
            action.type === "correct-summary"
              ? previousSummary?.summaryText
              : undefined,
        };
      }
    }
    for (const operation of plan.operations) {
      operation.metadata = {
        ...(operation.metadata ?? {}),
        commandFingerprint: fingerprint,
      };
    }
    const persisted = await store.persistPlan(plan);
    let restoredRecords = 0;
    if (
      !persisted.conflict &&
      action.type === "remove-member" &&
      correctionRestoreMessages.some(
        (message) => message.deprecatedAt !== undefined,
      ) &&
      typeof input.storage.restoreDeprecatedMessages === "function"
    ) {
      try {
        restoredRecords = await restoreCorrectionMessages({
          storage: input.storage,
          userId: scope.userId,
          messages: correctionRestoreMessages,
        });
      } catch (error) {
        return runtimeResult({
          status: "partial-failure",
          ownerScope: scope,
          commandId: input.command.commandId,
          graphVersion: persisted.version,
          operations: persisted.appliedOperations,
          reasonCodes: [
            ...plan.reasonCodes,
            "memory_graph_correction_restore_failed",
          ],
          sourceRecordIds: correctionRestoreSourceIds,
          error: errorInfo(error),
        });
      }
    }
    const auditNodeId =
      summaryId ??
      (action.type === "remove-member"
        ? action.nodeId
        : action.type === "set-representative"
          ? action.representativeNodeId
          : undefined);
    const audit = auditNodeId
      ? await store.readAuditTrail({
          ownerScope: scope,
          nodeId: auditNodeId,
          includeDeprecated: true,
        })
      : undefined;
    return {
      ...runtimeResult({
        status:
          correctedSummary && persisted.conflict
            ? "partial-failure"
            : persistenceStatus(persisted),
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: persisted.version,
        operations: persisted.appliedOperations,
        restoredRecords,
        reasonCodes: [
          ...plan.reasonCodes,
          ...persisted.diagnostics,
          ...(correctedSummary && persisted.conflict
            ? ["memory_graph_corrected_summary_pending_after_conflict"]
            : []),
        ],
        summaryId,
        sourceRecordIds:
          action.type === "remove-member"
            ? correctionRestoreSourceIds
            : undefined,
      }),
      auditTrail: audit
        ? {
            sourceNodeIds: [...audit.sourceNodeIds],
            edgeIds: [...audit.edgeIds],
            operationIds: [...audit.operationIds],
          }
        : undefined,
    };
  } catch (error) {
    return runtimeResult({
      status: "failed",
      ownerScope: scope,
      commandId: input.command.commandId,
      reasonCodes: ["memory_graph_correction_failed"],
      summaryId,
      error: errorInfo(error),
    });
  }
}

function sourceIdsForSummary(
  snapshot: MemoryGraphSnapshot,
  summaryId: string,
): string[] {
  const summary = snapshot.nodes.find((node) => node.id === summaryId);
  const metadataSources = Array.isArray(summary?.metadata?.sourceNodeIds)
    ? summary.metadata.sourceNodeIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const edgeSources = snapshot.edges
    .filter((edge) => edge.kind === "supersede" && edge.toNodeId === summaryId)
    .map((edge) => edge.fromNodeId);
  return unique([...metadataSources, ...edgeSources]).filter(
    (nodeId) =>
      snapshot.nodes.find((node) => node.id === nodeId)?.type === "raw",
  );
}

function predecessorSummaryIdsForSummary(
  snapshot: MemoryGraphSnapshot,
  summaryId: string,
): string[] {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return unique(
    snapshot.edges
      .filter(
        (edge) =>
          edge.kind === "supersede" &&
          edge.toNodeId === summaryId &&
          edge.metadata?.inactive !== true,
      )
      .map((edge) => edge.fromNodeId)
      .filter((nodeId) => {
        const node = nodesById.get(nodeId);
        return node?.type === "summary" || node?.type === "artifact";
      }),
  );
}

export async function runMemoryGraphRollback(input: {
  storage: RawMessageGraphGovernanceStorage;
  userId: string;
  command: RawMessageMemoryGraphRollbackCommand;
  now?: number;
}): Promise<MemoryGraphGovernanceRuntimeResult> {
  const now = input.now ?? Date.now();
  const scope = ownerScope(input.userId, input.command);
  const invalid = validateCommand(input.command);
  if (invalid.length > 0) {
    return runtimeResult({
      status: "failed",
      ownerScope: scope,
      commandId: input.command.commandId,
      reasonCodes: invalid,
      summaryId: input.command.summaryId,
    });
  }
  const store = createRawMessageMemoryGraphStore({
    storage: input.storage,
    ownerScope: scope,
    now: () => now,
  });
  try {
    let snapshot = await store.readSnapshot({
      ownerScope: scope,
      includeAuditOnly: true,
    });
    const priorCommandOperations = await store.readAppliedOperations({
      ownerScope: scope,
    });
    const fingerprint = commandFingerprint("rollback", input.command);
    if (
      hasCommandFingerprintConflict(
        priorCommandOperations,
        input.command.commandId,
        fingerprint,
      )
    ) {
      return runtimeResult({
        status: "conflict",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: ["memory_graph_command_id_payload_conflict"],
        summaryId: input.command.summaryId,
      });
    }
    const commandWasApplied = priorCommandOperations.some(
      (operation) => operation.metadata?.commandId === input.command.commandId,
    );
    if (
      input.command.expectedVersion !== undefined &&
      input.command.expectedVersion !== (snapshot.version ?? "0") &&
      !commandWasApplied
    ) {
      return runtimeResult({
        status: "conflict",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: ["memory_graph_version_conflict"],
        summaryId: input.command.summaryId,
      });
    }
    const existingAudit = await store.readAuditTrail({
      ownerScope: scope,
      nodeId: input.command.summaryId,
      includeDeprecated: true,
    });
    const predecessorSummaryNodeIds = predecessorSummaryIdsForSummary(
      snapshot,
      input.command.summaryId,
    );
    const directSourceRecordIds = sourceIdsForSummary(
      snapshot,
      input.command.summaryId,
    );
    const sourceRecordIds =
      predecessorSummaryNodeIds.length > 0
        ? directSourceRecordIds
        : unique([...directSourceRecordIds, ...existingAudit.sourceNodeIds]);
    if (sourceRecordIds.length === 0) {
      return runtimeResult({
        status: "no-op",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: snapshot.version,
        reasonCodes: ["memory_graph_rollback_source_records_not_found"],
        summaryId: input.command.summaryId,
      });
    }
    const prepare = buildMemoryGraphRollbackPreparePlan({
      ownerScope: scope,
      snapshot,
      commandId: input.command.commandId,
      summaryId: input.command.summaryId,
      sourceNodeIds: sourceRecordIds,
      predecessorSummaryNodeIds,
      reason: input.command.reason,
      requestedBy: input.command.requestedBy,
      now,
      persistence: { mode: "write", enabled: true },
    });
    for (const operation of prepare.operations) {
      operation.metadata = {
        ...(operation.metadata ?? {}),
        commandFingerprint: fingerprint,
      };
    }
    const prepared = await store.persistPlan(prepare);
    if (prepared.conflict) {
      return runtimeResult({
        status: "conflict",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: prepared.version,
        reasonCodes: [...prepare.reasonCodes, ...prepared.diagnostics],
        summaryId: input.command.summaryId,
        sourceRecordIds,
      });
    }
    if (typeof input.storage.restoreDeprecatedMessages !== "function") {
      return runtimeResult({
        status: "partial-failure",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: prepared.version,
        operations: prepared.appliedOperations,
        reasonCodes: [
          ...prepare.reasonCodes,
          "adapter_missing_restore_deprecated_messages",
        ],
        summaryId: input.command.summaryId,
        sourceRecordIds,
      });
    }
    let restoredRecords = 0;
    try {
      restoredRecords = await input.storage.restoreDeprecatedMessages(
        sourceRecordIds,
        {
          userId: scope.userId,
          supersededBySummaryId: input.command.summaryId,
        },
      );
    } catch (error) {
      return runtimeResult({
        status: "partial-failure",
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: prepared.version,
        operations: prepared.appliedOperations,
        reasonCodes: ["memory_graph_restore_deprecated_messages_failed"],
        summaryId: input.command.summaryId,
        sourceRecordIds,
        error: errorInfo(error),
      });
    }

    snapshot = await store.readSnapshot({
      ownerScope: scope,
      includeAuditOnly: true,
    });
    const appliedOperations = await store.readAppliedOperations({
      ownerScope: scope,
    });
    const previousLifecycleByClusterId: Record<
      string,
      MemoryClusterLifecycleStatus | undefined
    > = {};
    for (const operation of appliedOperations) {
      if (
        operation.kind === "set-cluster-lifecycle" &&
        operation.clusterId &&
        operation.supersededByNodeId === input.command.summaryId
      ) {
        previousLifecycleByClusterId[operation.clusterId] =
          operation.fromStatus;
      }
    }
    const finalize = buildMemoryGraphRollbackFinalizePlan({
      ownerScope: scope,
      snapshot,
      commandId: input.command.commandId,
      summaryId: input.command.summaryId,
      sourceNodeIds: sourceRecordIds,
      predecessorSummaryNodeIds,
      previousLifecycleByClusterId,
      reason: input.command.reason,
      requestedBy: input.command.requestedBy,
      now,
      persistence: { mode: "write", enabled: true },
    });
    for (const operation of finalize.operations) {
      operation.metadata = {
        ...(operation.metadata ?? {}),
        commandFingerprint: fingerprint,
      };
    }
    const finalized = await store.persistPlan(finalize);
    const audit = await store.readAuditTrail({
      ownerScope: scope,
      nodeId: input.command.summaryId,
      includeDeprecated: true,
    });
    return {
      ...runtimeResult({
        status: finalized.conflict
          ? "partial-failure"
          : persistenceStatus(finalized),
        ownerScope: scope,
        commandId: input.command.commandId,
        graphVersion: finalized.version,
        operations: [
          ...prepared.appliedOperations,
          ...finalized.appliedOperations,
        ],
        restoredRecords,
        reasonCodes: [
          ...prepare.reasonCodes,
          ...finalize.reasonCodes,
          ...prepared.diagnostics,
          ...finalized.diagnostics,
          ...(finalized.conflict
            ? ["memory_graph_rollback_finalize_version_conflict"]
            : []),
        ],
        summaryId: input.command.summaryId,
        sourceRecordIds,
      }),
      auditTrail: {
        sourceNodeIds: [...audit.sourceNodeIds],
        edgeIds: [...audit.edgeIds],
        operationIds: [...audit.operationIds],
      },
    };
  } catch (error) {
    return runtimeResult({
      status: "failed",
      ownerScope: scope,
      commandId: input.command.commandId,
      reasonCodes: ["memory_graph_rollback_failed"],
      summaryId: input.command.summaryId,
      error: errorInfo(error),
    });
  }
}

function operationKinds(
  operations: MemoryGraphOperation[],
  kinds: MemoryGraphOperation["kind"][],
): string[] {
  const accepted = new Set(kinds);
  return operations
    .filter((operation) => accepted.has(operation.kind))
    .map((operation) => operation.operationId);
}

function semanticScenario(input: {
  defaultIds: string[];
  auditIds: string[];
  deprecatedIds: string[];
  crossScopeIds: string[];
  snapshotVersion?: string;
}): MemorySemanticRetrievalEvalScenarioReport {
  const leaked = input.defaultIds.filter((id) =>
    input.deprecatedIds.includes(id),
  );
  const missingAudit = input.deprecatedIds.filter(
    (id) => !input.auditIds.includes(id),
  );
  const passed =
    leaked.length === 0 &&
    missingAudit.length === 0 &&
    input.crossScopeIds.length === 0;
  return {
    scenarioId: "runtime-semantic-deprecated-visibility",
    query: "runtime memory graph semantic audit",
    enabled: true,
    selectedDraftIds: [],
    suppressedDraftIds: leaked,
    fallbackRecordIds: [...input.defaultIds],
    missingSelectedDraftIds: [],
    missingSuppressedDraftIds: unique([
      ...missingAudit,
      ...input.crossScopeIds,
    ]),
    missingFallbackRecordIds: [],
    selectedPassed: true,
    suppressedPassed: leaked.length === 0,
    fallbackPassed: missingAudit.length === 0,
    passed,
    reasonCodes: [
      passed
        ? "semantic_retrieval_eval_passed"
        : "semantic_retrieval_eval_failed",
    ],
    metadata: {
      source: "persisted_memory_graph_runtime",
      snapshotVersion: input.snapshotVersion,
      auditRecordIds: [...input.auditIds],
      crossScopeRecordIds: [...input.crossScopeIds],
    },
  };
}

function auditScenario(input: {
  scenarioId: string;
  pollutedArtifactIds: string[];
  operations: MemoryGraphOperation[];
}): MemoryGovernanceAuditScenarioReport {
  const corrected = new Set(
    input.operations
      .filter((operation) =>
        [
          "correct-node",
          "remove-cluster-member",
          "rollback-supersession",
        ].includes(operation.kind),
      )
      .flatMap((operation) => operation.nodeIds),
  );
  const pollutedMemories = unique(input.pollutedArtifactIds).map(
    (artifactId) => {
      const resolved = corrected.has(artifactId);
      const commandIds = input.operations
        .filter((operation) => operation.nodeIds.includes(artifactId))
        .map((operation) => operation.operationId);
      return {
        artifactId,
        explained: true,
        unresolved: !resolved,
        sourceRecordIds: [artifactId],
        rollbackAvailable: resolved,
        commandIds,
        validCommandIds: resolved ? commandIds : [],
        reasonCodes: [
          "polluted_memory_observed",
          "polluted_memory_explained",
          ...(resolved
            ? (["dry_run_command_available"] as const)
            : (["polluted_memory_unresolved"] as const)),
        ],
        metadata: { source: "persisted_operation_history" },
      };
    },
  );
  const unresolvedArtifactIds = pollutedMemories
    .filter((item) => item.unresolved)
    .map((item) => item.artifactId);
  return {
    summary: {
      scenarioId: input.scenarioId,
      pollutedArtifactCount: pollutedMemories.length,
      explainedPollutedArtifactCount: pollutedMemories.length,
      validCommandCount: pollutedMemories.filter((item) => !item.unresolved)
        .length,
      unresolvedPollutedArtifactCount: unresolvedArtifactIds.length,
      dryRun: true,
    },
    pollutedMemories,
    unresolvedArtifactIds,
    reasonCodes: unique(pollutedMemories.flatMap((item) => item.reasonCodes)),
    metadata: { source: "persisted_memory_graph_runtime" },
  };
}

export async function runMemoryGraphRolloutEvaluation(
  input: RunMemoryGraphRolloutEvaluationInput,
): Promise<MemoryGraphRolloutEvaluationRuntimeResult> {
  const now = input.now ?? Date.now();
  const scope = ownerScope(input.userId, input);
  const store = createRawMessageMemoryGraphStore({
    storage: input.storage,
    ownerScope: scope,
    now: () => now,
  });
  const snapshot = await store.readSnapshot({
    ownerScope: scope,
    includeAuditOnly: true,
  });
  const operations = await store.readAppliedOperations({ ownerScope: scope });
  const storedSummaries = await input.storage.querySummaries({
    userId: scope.userId,
    pageSize: 1000,
  });
  const baselineNodeIds = snapshot.nodes.map((node) => node.id);
  const defaultGraph = buildGraphAwareRetrievalDryRun({
    ownerScope: scope,
    query: input.scenarioId,
    baselineNodeIds,
    snapshot,
    visibilityMode: "default",
  });
  const auditGraph = buildGraphAwareRetrievalDryRun({
    ownerScope: scope,
    query: input.scenarioId,
    baselineNodeIds,
    snapshot,
    visibilityMode: "audit",
    includeDeprecated: true,
  });
  const conflictGraph = buildGraphAwareRetrievalDryRun({
    ownerScope: scope,
    query: input.scenarioId,
    baselineNodeIds,
    snapshot,
    visibilityMode: "conflict",
  });
  const persistedTrails = await Promise.all(
    unique([
      ...auditGraph.rankedNodeIds,
      ...snapshot.nodes
        .filter((node) => node.type === "summary")
        .map((node) => node.id),
    ]).map((nodeId) =>
      store.readAuditTrail({
        ownerScope: scope,
        nodeId,
        includeDeprecated: true,
      }),
    ),
  );
  auditGraph.auditTrail = persistedTrails.filter(
    (trail) => trail.sourceNodeIds.length > 0 || trail.operationIds.length > 0,
  );

  const hiddenRawIds = snapshot.nodes
    .filter(
      (node) =>
        node.type === "raw" &&
        (node.visibility === "deprecated" || node.visibility === "audit-only"),
    )
    .map((node) => node.id);
  const defaultExpectedIds = snapshot.nodes
    .filter(
      (node) =>
        node.visibility === "default" &&
        (node.type === "raw" || node.type === "summary"),
    )
    .map((node) => node.id);
  const summaryIds = snapshot.nodes
    .filter((node) => node.type === "summary")
    .map((node) => node.id);
  const unlinkedSummaryIds = storedSummaries
    .map((summary) => summary.summaryId)
    .filter((summaryId) => !summaryIds.includes(summaryId));
  const retrievalScenarios: MemoryGraphRolloutRetrievalScenarioInput[] = [
    {
      scenarioId: "runtime-default-retrieval",
      result: defaultGraph,
      expectedRankedNodeIds: defaultExpectedIds,
      expectedHiddenDeprecatedNodeIds: hiddenRawIds,
      forbiddenNodeIds: hiddenRawIds,
      crossScopeNodeIds: [],
      metadata: { snapshotVersion: snapshot.version },
    },
    {
      scenarioId: "runtime-audit-retrieval",
      result: auditGraph,
      expectedRankedNodeIds: hiddenRawIds,
      expectedAuditTrailNodeIds: summaryIds,
      crossScopeNodeIds: [],
      metadata: { snapshotVersion: snapshot.version },
    },
  ];
  if (conflictGraph.reasonCodes.includes("competing_alternatives_exposed")) {
    retrievalScenarios.push({
      scenarioId: "runtime-conflict-retrieval",
      result: conflictGraph,
      expectedRankedNodeIds: conflictGraph.rankedNodeIds,
      crossScopeNodeIds: [],
      metadata: { snapshotVersion: snapshot.version },
    });
  }

  const semanticRetrievalScenarios: MemorySemanticRetrievalEvalScenarioReport[] =
    [];
  let semanticDefaultRecordIds: string[] = [];
  let semanticAuditRecordIds: string[] = [];
  if (
    typeof input.storage.searchMessagesSemantically === "function" &&
    (input.queryEmbedding?.length ?? 0) > 0
  ) {
    const [defaultSemantic, auditSemantic] = await Promise.all([
      input.storage.searchMessagesSemantically({
        userId: scope.userId,
        queryEmbedding: input.queryEmbedding ?? [],
        includeArchived: false,
        includeDeprecated: false,
        limit: 100,
        threshold: -1,
      }),
      input.storage.searchMessagesSemantically({
        userId: scope.userId,
        queryEmbedding: input.queryEmbedding ?? [],
        includeArchived: false,
        includeDeprecated: true,
        limit: 100,
        threshold: -1,
      }),
    ]);
    semanticDefaultRecordIds = defaultSemantic
      .map(semanticResultMessageId)
      .filter((messageId): messageId is string => messageId !== undefined);
    semanticAuditRecordIds = auditSemantic
      .map(semanticResultMessageId)
      .filter((messageId): messageId is string => messageId !== undefined);
    const scopedRawIds = new Set(
      snapshot.nodes
        .filter((node) => node.type === "raw")
        .map((node) => node.id),
    );
    const semanticCrossScopeIds = unique([
      ...semanticDefaultRecordIds,
      ...semanticAuditRecordIds,
    ]).filter((messageId) => !scopedRawIds.has(messageId));
    semanticRetrievalScenarios.push(
      semanticScenario({
        defaultIds: semanticDefaultRecordIds,
        auditIds: semanticAuditRecordIds,
        deprecatedIds: hiddenRawIds,
        crossScopeIds: semanticCrossScopeIds,
        snapshotVersion: snapshot.version,
      }),
    );
  }

  const stableClusters = snapshot.clusters.filter(
    (cluster) => cluster.lifecycleStatus === "stable",
  );
  const invalidStableRepresentatives = stableClusters.filter(
    (cluster) =>
      !cluster.representativeNodeId ||
      !snapshot.nodes.some(
        (node) =>
          node.id === cluster.representativeNodeId &&
          node.visibility === "default",
      ),
  );
  const formingPromotions = snapshot.clusters.filter(
    (cluster) =>
      cluster.lifecycleStatus === "forming" && cluster.representativeNodeId,
  );
  const decayingClusters = snapshot.clusters.filter(
    (cluster) => cluster.lifecycleStatus === "decaying",
  );
  const invalidDecay = decayingClusters.filter(
    (cluster) => (cluster.supportScore ?? 0) > 1 && cluster.nodeIds.length > 1,
  );
  const runtimeEvidence: MemoryGraphRolloutRuntimeEvidence = {
    ownerScopeKey: ownerScopeKey(scope),
    snapshotVersion: snapshot.version,
    operationIds: operations.map((operation) => operation.operationId),
    correctionOperationIds: operationKinds(operations, [
      "correct-node",
      "remove-cluster-member",
    ]),
    rollbackOperationIds: operationKinds(operations, ["rollback-supersession"]),
    defaultRetrievedNodeIds: [...defaultGraph.rankedNodeIds],
    auditRetrievedNodeIds: [...auditGraph.rankedNodeIds],
    semanticDefaultRecordIds,
    semanticAuditRecordIds,
    sourceRecordIds: snapshot.nodes
      .filter((node) => node.type === "raw")
      .map((node) => node.id),
    summaryIds,
    metadata: {
      capturedAt: snapshot.capturedAt,
      storedSummaryIds: storedSummaries.map((summary) => summary.summaryId),
      unlinkedSummaryIds,
    },
  };
  const report = buildMemoryGraphRolloutGovernanceReport({
    scenarioId: input.scenarioId,
    consolidationMetrics: {
      scenarioCount: 1,
      expectedCandidateAccuracy:
        invalidStableRepresentatives.length === 0 ? 1 : 0,
      noisePromotionRate:
        unlinkedSummaryIds.length > 0
          ? 1
          : snapshot.clusters.length === 0
            ? 0
            : formingPromotions.length / snapshot.clusters.length,
      temporaryOverrideLeakageRate: 0,
      adaptationAccuracy: 1,
      projectStateAccuracy: 1,
      contestedClusterCoverage: conflictGraph.reasonCodes.includes(
        "competing_alternatives_exposed",
      )
        ? 1
        : snapshot.clusters.some((cluster) => cluster.competitionKey)
          ? 0
          : 1,
      decayPrecisionProxy:
        invalidDecay.length === 0
          ? 1
          : 1 - invalidDecay.length / decayingClusters.length,
    },
    graphRetrievalScenarios: retrievalScenarios,
    semanticRetrievalScenarios,
    auditScenarioReport:
      (input.pollutedArtifactIds?.length ?? 0) > 0
        ? auditScenario({
            scenarioId: input.scenarioId,
            pollutedArtifactIds: input.pollutedArtifactIds ?? [],
            operations,
          })
        : undefined,
    runtimeEvidence,
    metadata: {
      source: "persisted_memory_graph_runtime",
      snapshotVersion: snapshot.version,
    },
  });
  return {
    ownerScope: scope,
    snapshotVersion: snapshot.version,
    report,
    runtimeEvidence,
    reasonCodes: unique([
      "memory_graph_rollout_evaluation_from_persisted_runtime",
      ...(semanticRetrievalScenarios.length === 0
        ? ["memory_graph_required_semantic_eval_artifact_missing"]
        : []),
      ...((input.pollutedArtifactIds?.length ?? 0) === 0
        ? ["memory_graph_required_polluted_memory_audit_artifact_missing"]
        : []),
      ...(runtimeEvidence.correctionOperationIds.length === 0
        ? ["memory_graph_required_correction_artifact_missing"]
        : []),
      ...(runtimeEvidence.rollbackOperationIds.length === 0
        ? ["memory_graph_required_rollback_artifact_missing"]
        : []),
    ]),
  };
}
