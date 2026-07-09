import type {
  MemoryForgettingDeprecationDiagnostic,
  MemoryForgettingRunInput,
  MemoryForgettingRunResult,
  MemoryGroup,
  MemoryRecord,
  MemoryRecordScorer,
  MemoryStorageAdapter,
  MemorySummary,
  MemorySummarizer,
  ScoredMemoryRecord,
} from "./contracts";
import {
  deprecateMemoryRecords,
  type DeprecatablePlanEntry,
  type DeprecateMemoryRecordsResult,
} from "./deprecation";
import {
  bucketStart,
  type MemoryForgettingPolicy,
  type MemoryForgettingPolicyOverrides,
  resolveMemoryForgettingPolicy,
  summaryTierForTransition,
  transitionTargetTier,
} from "./policy";
import { DefaultMemoryRecordScorer } from "./scorer";
import { RuleBasedMemorySummarizer } from "./summarizer";

export interface MemoryForgettingEngine {
  readonly policy: MemoryForgettingPolicy;
  runCycle(input: MemoryForgettingRunInput): Promise<MemoryForgettingRunResult>;
}

export interface MemoryForgettingDeprecationOptions {
  /**
   * Defaults to true. Missing adapter support still degrades to diagnostics, so
   * older stores remain compatible while capable stores soft-hide sources.
   */
  enabled?: boolean;
}

export interface CreateMemoryForgettingEngineInput {
  storage: MemoryStorageAdapter;
  policy?: MemoryForgettingPolicyOverrides;
  scorer?: MemoryRecordScorer;
  summarizer?: MemorySummarizer;
  deprecation?: MemoryForgettingDeprecationOptions;
}

function clampTimestamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function stableDimensionKey(
  record: MemoryRecord,
  dimensionKeys: string[],
): string {
  const dimensions = record.dimensions ?? {};
  return dimensionKeys
    .map((key) => `${key}=${String(dimensions[key] ?? "")}`)
    .join("|");
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // Unsigned 32-bit.
  return (hash >>> 0).toString(16);
}

function buildSummaryDeprecationEntry(
  summary: MemorySummary,
): DeprecatablePlanEntry {
  return {
    action: "deprecate",
    recordIds: [...summary.sourceRecordIds],
    supersededBySummaryId: summary.summaryId,
    deprecationReason: `summarized_into:${summary.summaryId}`,
  };
}

function toDeprecationDiagnostic(
  summaryId: string,
  result: DeprecateMemoryRecordsResult,
): MemoryForgettingDeprecationDiagnostic {
  return {
    summaryId,
    status: result.status,
    plannedRecordIds: result.plannedRecordIds,
    plannedCount: result.plannedCount,
    persistedCount: result.persistedCount,
    reasonCodes: result.reasonCodes,
  };
}

function errorInfo(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

async function deprecateSummarySources(input: {
  storage: MemoryStorageAdapter;
  userId: string;
  summary: MemorySummary;
  now: number;
  enabled: boolean;
}): Promise<MemoryForgettingDeprecationDiagnostic> {
  try {
    const result = await deprecateMemoryRecords({
      userId: input.userId,
      entries: [buildSummaryDeprecationEntry(input.summary)],
      store: input.storage,
      now: input.now,
      enabled: input.enabled,
    });
    return toDeprecationDiagnostic(input.summary.summaryId, result);
  } catch (error) {
    return {
      summaryId: input.summary.summaryId,
      status: "failed",
      plannedRecordIds: [...input.summary.sourceRecordIds],
      plannedCount: input.summary.sourceRecordIds.length,
      persistedCount: 0,
      reasonCodes: ["adapter_error"],
      error: errorInfo(error),
    };
  }
}

function buildSummaryId(input: {
  userId: string;
  summaryTier: string;
  groupId: string;
  endTimestamp: number;
}): string {
  const raw = `${input.userId}|${input.summaryTier}|${input.groupId}|${input.endTimestamp}`;
  return `ms_${hashString(raw)}`;
}

function toScoredRecords(
  records: MemoryRecord[],
  scorer: MemoryRecordScorer,
  now: number,
): ScoredMemoryRecord[] {
  return records.map((record) => ({
    ...record,
    ageMs: Math.max(0, now - record.timestamp),
    valueScore: scorer.score(record, { now }),
  }));
}

function groupRecordsForTransition(params: {
  userId: string;
  records: ScoredMemoryRecord[];
  fromTier: "short" | "mid";
  windowMs: number;
  minRecordsPerGroup: number;
  groupByDimensionKeys: string[];
}): MemoryGroup[] {
  const grouped = new Map<string, ScoredMemoryRecord[]>();
  const targetTier = transitionTargetTier(params.fromTier);
  const summaryTier = summaryTierForTransition(params.fromTier);

  for (const record of params.records) {
    const bucket = bucketStart(record.timestamp, params.windowMs);
    const dimKey = stableDimensionKey(record, params.groupByDimensionKeys);
    const key = `${params.fromTier}|${bucket}|${dimKey}`;
    const list = grouped.get(key);
    if (list) {
      list.push(record);
    } else {
      grouped.set(key, [record]);
    }
  }

  const groups: MemoryGroup[] = [];
  for (const [groupId, records] of grouped.entries()) {
    if (records.length < params.minRecordsPerGroup) {
      continue;
    }
    const startTimestamp = Math.min(
      ...records.map((record) => record.timestamp),
    );
    const endTimestamp = Math.max(...records.map((record) => record.timestamp));
    groups.push({
      groupId,
      userId: params.userId,
      sourceTier: params.fromTier,
      targetTier,
      summaryTier,
      records,
      startTimestamp,
      endTimestamp,
      dimensions: records[0]?.dimensions,
    });
  }
  return groups.sort((a, b) => b.endTimestamp - a.endTimestamp);
}

export function createMemoryForgettingEngine(
  input: CreateMemoryForgettingEngineInput,
): MemoryForgettingEngine {
  const policy = resolveMemoryForgettingPolicy(input.policy);
  const scorer = input.scorer ?? new DefaultMemoryRecordScorer();
  const summarizer = input.summarizer ?? new RuleBasedMemorySummarizer();

  return {
    policy,
    async runCycle(runInput: MemoryForgettingRunInput) {
      const startedAt = Date.now();
      const now = runInput.now ?? startedAt;
      const dryRun = runInput.dryRun ?? false;
      const lockKey = `${policy.lock.keyPrefix}:${runInput.userId}`;

      const lock = await input.storage.acquireLock({
        key: lockKey,
        ttlMs: policy.lock.ttlMs,
        now,
      });

      if (!lock) {
        return {
          status: "skipped_locked",
          dryRun,
          userId: runInput.userId,
          startedAt,
          finishedAt: Date.now(),
          scannedRecords: 0,
          eligibleRecords: 0,
          createdSummaries: 0,
          transitionedRecords: 0,
          archivedDetailRecords: 0,
          deprecatedRecords: 0,
          deprecationDiagnostics: [],
        };
      }

      let scannedRecords = 0;
      let eligibleRecords = 0;
      let createdSummaries = 0;
      let transitionedRecords = 0;
      let archivedDetailRecords = 0;
      let deprecatedRecords = 0;
      const deprecationDiagnostics: MemoryForgettingDeprecationDiagnostic[] =
        [];

      try {
        const phases: Array<{
          fromTier: "short" | "mid";
          olderThan: number;
          threshold: number;
          candidateLimit: number;
          windowMs: number;
        }> = [
          {
            fromTier: "short",
            olderThan: now - policy.shortMaxAgeMs,
            threshold: policy.scoreThresholds.shortToMid,
            candidateLimit: policy.maxCandidatesPerTierPerRun.short,
            windowMs: policy.groupWindowMs.short,
          },
          {
            fromTier: "mid",
            olderThan: now - policy.midMaxAgeMs,
            threshold: policy.scoreThresholds.midToLong,
            candidateLimit: policy.maxCandidatesPerTierPerRun.mid,
            windowMs: policy.groupWindowMs.mid,
          },
        ];

        for (const phase of phases) {
          const records = await input.storage.listCandidates({
            userId: runInput.userId,
            tier: phase.fromTier,
            olderThan: phase.olderThan,
            limit: phase.candidateLimit,
          });

          scannedRecords += records.length;

          const scored = toScoredRecords(records, scorer, now);
          const eligible = scored.filter(
            (record) =>
              !record.isPinned &&
              record.archivedAt === undefined &&
              record.deprecatedAt === undefined &&
              record.valueScore <= phase.threshold,
          );

          eligibleRecords += eligible.length;

          if (eligible.length === 0) {
            continue;
          }

          const groups = groupRecordsForTransition({
            userId: runInput.userId,
            records: eligible,
            fromTier: phase.fromTier,
            windowMs: phase.windowMs,
            minRecordsPerGroup: policy.minRecordsPerGroup,
            groupByDimensionKeys: policy.groupByDimensionKeys,
          });

          for (const group of groups) {
            const draft = await summarizer.summarizeGroup(group, { now });
            const summary: MemorySummary = {
              summaryId: buildSummaryId({
                userId: runInput.userId,
                summaryTier: group.summaryTier,
                groupId: group.groupId,
                endTimestamp: group.endTimestamp,
              }),
              userId: runInput.userId,
              summaryTier: group.summaryTier,
              sourceTier: group.sourceTier,
              startTimestamp: clampTimestamp(group.startTimestamp),
              endTimestamp: clampTimestamp(group.endTimestamp),
              messageCount: group.records.length,
              sourceRecordIds: group.records.map((record) => record.id),
              keyPoints: draft.keyPoints,
              keywords: draft.keywords,
              summaryText: draft.summaryText,
              dimensions: group.dimensions,
              qualityScore: draft.qualityScore,
              createdAt: now,
              updatedAt: now,
            };

            createdSummaries += 1;
            transitionedRecords += group.records.length;

            if (!dryRun) {
              await input.storage.saveSummaries([summary]);
              const deprecationDiagnostic = await deprecateSummarySources({
                storage: input.storage,
                userId: runInput.userId,
                summary,
                now,
                enabled: input.deprecation?.enabled ?? true,
              });
              deprecationDiagnostics.push(deprecationDiagnostic);
              deprecatedRecords += deprecationDiagnostic.persistedCount;

              await input.storage.transitionRecords({
                userId: runInput.userId,
                ids: summary.sourceRecordIds,
                toTier: group.targetTier,
                transitionedAt: now,
                summaryId: summary.summaryId,
              });

              if (
                group.targetTier === "long" &&
                input.storage.archiveRecordDetails
              ) {
                await input.storage.archiveRecordDetails({
                  userId: runInput.userId,
                  ids: summary.sourceRecordIds,
                  archivedAt: now,
                });
                archivedDetailRecords += summary.sourceRecordIds.length;
              }
            }
          }
        }
      } finally {
        await input.storage.releaseLock(lock);
      }

      return {
        status: "success",
        dryRun,
        userId: runInput.userId,
        startedAt,
        finishedAt: Date.now(),
        scannedRecords,
        eligibleRecords,
        createdSummaries,
        transitionedRecords,
        archivedDetailRecords,
        deprecatedRecords,
        deprecationDiagnostics,
      };
    },
  };
}
