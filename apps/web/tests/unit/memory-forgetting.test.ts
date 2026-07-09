import { describe, expect, it } from "vitest";
import {
  createMemoryForgettingEngine,
  createMemoryQueryApi,
  normalizeMemoryRecordForIngest,
  normalizeMemoryRecordsForIngest,
  type MemoryDeprecateRecordsInput,
  type MemoryLockHandle,
  type MemoryPageResult,
  type MemoryRecord,
  type MemorySearchQuery,
  type MemoryStorageAdapter,
  type MemorySummary,
  type MemorySummarySearchQuery,
  DEFAULT_MEMORY_FORGETTING_POLICY,
  resolveMemoryForgettingPolicy,
  summaryTierForTransition,
  transitionTargetTier,
  DefaultMemoryRecordScorer,
  RuleBasedMemorySummarizer,
} from "../../../../packages/ai/src/memory";

class InMemoryStorageAdapter implements MemoryStorageAdapter {
  records: MemoryRecord[] = [];
  summaries: MemorySummary[] = [];
  lockAvailable = true;
  acquireCalls = 0;
  releaseCalls = 0;
  saveSummaryCalls = 0;
  transitionCalls = 0;
  archiveCalls = 0;
  deprecateCalls = 0;
  markAccessCalls = 0;
  deprecateInputs: MemoryDeprecateRecordsInput[] = [];
  events: string[] = [];

  async acquireLock(input: {
    key: string;
    ttlMs: number;
    now: number;
  }): Promise<MemoryLockHandle | null> {
    this.acquireCalls += 1;
    if (!this.lockAvailable) return null;
    return {
      key: input.key,
      token: "lock-token",
      acquiredAt: input.now,
      expiresAt: input.now + input.ttlMs,
    };
  }

  async releaseLock(): Promise<void> {
    this.releaseCalls += 1;
  }

  async listCandidates(input: {
    userId: string;
    tier: "short" | "mid" | "long";
    olderThan: number;
    limit: number;
  }): Promise<MemoryRecord[]> {
    return this.records
      .filter(
        (record) =>
          record.userId === input.userId &&
          record.tier === input.tier &&
          record.timestamp <= input.olderThan,
      )
      .slice(0, input.limit);
  }

  async saveSummaries(summaries: MemorySummary[]): Promise<void> {
    this.saveSummaryCalls += 1;
    this.events.push("saveSummaries");
    this.summaries.push(...summaries);
  }

  async transitionRecords(input: {
    userId: string;
    ids: string[];
    toTier: "short" | "mid" | "long";
    transitionedAt: number;
    summaryId?: string;
  }): Promise<void> {
    this.transitionCalls += 1;
    this.events.push("transitionRecords");
    for (const record of this.records) {
      if (record.userId !== input.userId) continue;
      if (!input.ids.includes(record.id)) continue;
      record.tier = input.toTier;
      record.metadata = {
        ...(record.metadata ?? {}),
        transitionedAt: input.transitionedAt,
        summaryId: input.summaryId,
      };
    }
  }

  async archiveRecordDetails(input: {
    userId: string;
    ids: string[];
    archivedAt: number;
  }): Promise<void> {
    this.archiveCalls += 1;
    this.events.push("archiveRecordDetails");
    for (const record of this.records) {
      if (record.userId !== input.userId) continue;
      if (!input.ids.includes(record.id)) continue;
      record.archivedAt = input.archivedAt;
      record.text = undefined;
    }
  }

  async queryRaw(
    _query: MemorySearchQuery,
  ): Promise<MemoryPageResult<MemoryRecord>> {
    return { items: [], hasMore: false };
  }

  async querySummaries(
    _query: MemorySummarySearchQuery,
  ): Promise<MemoryPageResult<MemorySummary>> {
    return { items: [], hasMore: false };
  }

  async markRecordsAccessed(input: {
    userId: string;
    ids: string[];
    at: number;
  }): Promise<void> {
    this.markAccessCalls += 1;
    for (const record of this.records) {
      if (record.userId !== input.userId) continue;
      if (!input.ids.includes(record.id)) continue;
      record.lastAccessAt = input.at;
      record.accessCount = (record.accessCount ?? 0) + 1;
    }
  }

  async deprecateRecords(input: MemoryDeprecateRecordsInput): Promise<number> {
    this.deprecateCalls += 1;
    this.deprecateInputs.push(input);
    this.events.push("deprecateRecords");
    let affectedRows = 0;
    for (const record of this.records) {
      if (record.userId !== input.userId) continue;
      if (!input.ids.includes(record.id)) continue;
      if (record.deprecatedAt !== undefined) continue;
      record.deprecatedAt = input.deprecatedAt;
      record.deprecationReason = input.reason;
      record.supersededBySummaryId = input.supersededBySummaryId;
      affectedRows += 1;
    }
    return affectedRows;
  }
}

function createRecord(
  input: Partial<MemoryRecord> & { id: string },
): MemoryRecord {
  return {
    id: input.id,
    userId: input.userId ?? "u1",
    timestamp: input.timestamp ?? Date.now(),
    text: input.text,
    mediaRefs: input.mediaRefs,
    embedding: input.embedding,
    embeddingModel: input.embeddingModel,
    embeddingContentHash: input.embeddingContentHash,
    embeddingDimensions: input.embeddingDimensions,
    embeddingUpdatedAt: input.embeddingUpdatedAt,
    tier: input.tier ?? "short",
    accessCount: input.accessCount,
    lastAccessAt: input.lastAccessAt,
    importanceScore: input.importanceScore,
    isPinned: input.isPinned,
    archivedAt: input.archivedAt,
    dimensions: input.dimensions,
    metadata: input.metadata,
    deprecatedAt: input.deprecatedAt,
    deprecationReason: input.deprecationReason,
    supersededBySummaryId: input.supersededBySummaryId,
  };
}

describe("memory policy", () => {
  it("resolves defaults and partial overrides", () => {
    const policy = resolveMemoryForgettingPolicy({
      shortMaxAgeMs: 123,
      scoreThresholds: { midToLong: 0.4 },
      lock: { ttlMs: 5000 },
    });

    expect(policy.shortMaxAgeMs).toBe(123);
    expect(policy.midMaxAgeMs).toBe(
      DEFAULT_MEMORY_FORGETTING_POLICY.midMaxAgeMs,
    );
    expect(policy.scoreThresholds.shortToMid).toBe(
      DEFAULT_MEMORY_FORGETTING_POLICY.scoreThresholds.shortToMid,
    );
    expect(policy.scoreThresholds.midToLong).toBe(0.4);
    expect(policy.lock.ttlMs).toBe(5000);
  });

  it("maps transition and summary tiers", () => {
    expect(summaryTierForTransition("short")).toBe("L1");
    expect(summaryTierForTransition("mid")).toBe("L2");
    expect(transitionTargetTier("short")).toBe("mid");
    expect(transitionTargetTier("mid")).toBe("long");
  });
});

describe("memory scorer", () => {
  it("prioritizes recently accessed and pinned records", () => {
    const scorer = new DefaultMemoryRecordScorer();
    const now = Date.now();

    const oldCold = createRecord({
      id: "old-cold",
      timestamp: now - 200 * 24 * 60 * 60 * 1000,
      text: "random note",
      accessCount: 0,
      importanceScore: 0,
    });

    const recentHot = createRecord({
      id: "recent-hot",
      timestamp: now - 1 * 24 * 60 * 60 * 1000,
      text: "urgent deadline and action item",
      accessCount: 8,
      importanceScore: 0.9,
      isPinned: true,
    });

    const oldScore = scorer.score(oldCold, { now });
    const recentScore = scorer.score(recentHot, { now });

    expect(oldScore).toBeGreaterThanOrEqual(0);
    expect(oldScore).toBeLessThanOrEqual(1);
    expect(recentScore).toBeGreaterThan(oldScore);
    expect(recentScore).toBeLessThanOrEqual(1);
  });
});

describe("rule-based summarizer", () => {
  it("creates compact highlights and keywords", async () => {
    const summarizer = new RuleBasedMemorySummarizer();
    const now = Date.now();
    const longText = `This is a very long statement ${"x".repeat(220)}`;

    const group = {
      groupId: "g1",
      userId: "u1",
      sourceTier: "short" as const,
      targetTier: "mid" as const,
      summaryTier: "L1" as const,
      startTimestamp: now - 10_000,
      endTimestamp: now,
      dimensions: { platform: "slack" },
      records: [
        {
          ...createRecord({
            id: "r1",
            timestamp: now - 10_000,
            text: longText,
          }),
          ageMs: 10_000,
          valueScore: 0.3,
        },
        {
          ...createRecord({
            id: "r2",
            timestamp: now - 9_000,
            text: "deadline migration plan with rollback path",
          }),
          ageMs: 9_000,
          valueScore: 0.4,
        },
        {
          ...createRecord({
            id: "r3",
            timestamp: now - 8_000,
            text: "deadline migration plan with rollback path",
          }),
          ageMs: 8_000,
          valueScore: 0.4,
        },
      ],
    };

    const summary = await summarizer.summarizeGroup(group);

    expect(summary.summaryText).toContain("Tier transition: short -> mid (L1)");
    expect(summary.keyPoints.length).toBeGreaterThan(0);
    expect(summary.keyPoints[0]?.endsWith("...")).toBe(true);
    expect(summary.keywords.length).toBeGreaterThan(0);
  });
});

describe("memory ingest", () => {
  it("defaults tier to short when tier is omitted", () => {
    const now = Date.now();
    const normalized = normalizeMemoryRecordForIngest({
      id: "ingest-1",
      userId: "u1",
      timestamp: now,
      text: "new message",
    });

    expect(normalized.tier).toBe("short");
  });

  it("preserves embedding metadata during ingest normalization", () => {
    const now = Date.now();
    const normalized = normalizeMemoryRecordForIngest({
      id: "ingest-embedding",
      userId: "u1",
      timestamp: now,
      text: "message with vector",
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "text-embedding-3-small",
      embeddingContentHash: "memory-record-embedding-text-v1:abc",
      embeddingDimensions: 3,
      embeddingUpdatedAt: now,
    });

    expect(normalized.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(normalized.embeddingModel).toBe("text-embedding-3-small");
    expect(normalized.embeddingContentHash).toBe(
      "memory-record-embedding-text-v1:abc",
    );
    expect(normalized.embeddingDimensions).toBe(3);
    expect(normalized.embeddingUpdatedAt).toBe(now);
  });

  it("normalizes batch records and preserves explicit tiers", () => {
    const now = Date.now();
    const normalized = normalizeMemoryRecordsForIngest([
      {
        id: "ingest-2",
        userId: "u1",
        timestamp: now,
        text: "message a",
      },
      {
        id: "ingest-3",
        userId: "u1",
        timestamp: now,
        text: "message b",
        tier: "mid",
      },
    ]);

    expect(normalized[0]?.tier).toBe("short");
    expect(normalized[1]?.tier).toBe("mid");
  });
});

describe("memory forgetting engine", () => {
  it("returns skipped_locked when lock cannot be acquired", async () => {
    const storage = new InMemoryStorageAdapter();
    storage.lockAvailable = false;
    const engine = createMemoryForgettingEngine({ storage });

    const result = await engine.runCycle({ userId: "u1" });

    expect(result.status).toBe("skipped_locked");
    expect(result.deprecatedRecords).toBe(0);
    expect(result.deprecationDiagnostics).toEqual([]);
    expect(storage.acquireCalls).toBe(1);
    expect(storage.releaseCalls).toBe(0);
  });

  it("computes transitions in dryRun without persisting writes", async () => {
    const storage = new InMemoryStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    storage.records = [
      createRecord({
        id: "s1",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 1_000,
        text: "low value one",
      }),
      createRecord({
        id: "s2",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 2_000,
        text: "low value two",
      }),
      createRecord({
        id: "s3",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 3_000,
        text: "low value three",
      }),
    ];

    const engine = createMemoryForgettingEngine({ storage });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: true });

    expect(result.status).toBe("success");
    expect(result.createdSummaries).toBe(1);
    expect(result.transitionedRecords).toBe(3);
    expect(storage.saveSummaryCalls).toBe(0);
    expect(storage.transitionCalls).toBe(0);
    expect(storage.archiveCalls).toBe(0);
    expect(storage.deprecateCalls).toBe(0);
    expect(result.deprecatedRecords).toBe(0);
    expect(result.deprecationDiagnostics).toEqual([]);
    expect(storage.releaseCalls).toBe(1);
  });

  it("does not transition pinned records during forgetting", async () => {
    const storage = new InMemoryStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    storage.records = [
      createRecord({
        id: "s1",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 1_000,
        text: "low value one",
      }),
      createRecord({
        id: "s2",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 2_000,
        text: "low value two",
      }),
      createRecord({
        id: "s3",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 3_000,
        text: "low value three",
      }),
      createRecord({
        id: "pinned",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 4_000,
        text: "pinned low value note",
        isPinned: true,
      }),
    ];

    const engine = createMemoryForgettingEngine({ storage });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: false });

    expect(result.createdSummaries).toBe(1);
    expect(result.transitionedRecords).toBe(3);
    expect(storage.summaries[0]?.sourceRecordIds).not.toContain("pinned");
    expect(storage.records.find((record) => record.id === "pinned")?.tier).toBe(
      "short",
    );
  });

  it("persists summary and transitions records when not dryRun", async () => {
    const storage = new InMemoryStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    const midWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.midMaxAgeMs - 14 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.mid,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.mid;
    storage.records = [
      createRecord({
        id: "s1",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 1_000,
        text: "old short one",
      }),
      createRecord({
        id: "s2",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 2_000,
        text: "old short two",
      }),
      createRecord({
        id: "s3",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 3_000,
        text: "old short three",
      }),
      createRecord({
        id: "m1",
        userId: "u1",
        tier: "mid",
        timestamp: midWindowStart + 1_000,
        text: "old mid one",
      }),
      createRecord({
        id: "m2",
        userId: "u1",
        tier: "mid",
        timestamp: midWindowStart + 2_000,
        text: "old mid two",
      }),
      createRecord({
        id: "m3",
        userId: "u1",
        tier: "mid",
        timestamp: midWindowStart + 3_000,
        text: "old mid three",
      }),
    ];

    const engine = createMemoryForgettingEngine({ storage });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: false });

    expect(result.createdSummaries).toBe(2);
    expect(result.transitionedRecords).toBe(6);
    expect(result.deprecatedRecords).toBe(6);
    expect(storage.saveSummaryCalls).toBeGreaterThan(0);
    expect(storage.deprecateCalls).toBe(2);
    expect(storage.transitionCalls).toBeGreaterThan(0);
    expect(storage.archiveCalls).toBeGreaterThan(0);

    const shortNowMid = storage.records.filter(
      (record) => record.id.startsWith("s") && record.tier === "mid",
    );
    const midNowLong = storage.records.filter(
      (record) => record.id.startsWith("m") && record.tier === "long",
    );
    expect(shortNowMid.length).toBe(3);
    expect(midNowLong.length).toBe(3);
    expect(midNowLong.every((record) => record.archivedAt !== undefined)).toBe(
      true,
    );
    expect(storage.records.every((record) => record.deprecatedAt === now)).toBe(
      true,
    );
  });

  it("soft-deprecates source records after summary save and before transition", async () => {
    const storage = new InMemoryStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    storage.records = [
      createRecord({
        id: "s1",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 1_000,
        text: "old short one",
      }),
      createRecord({
        id: "s2",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 2_000,
        text: "old short two",
      }),
      createRecord({
        id: "s3",
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + 3_000,
        text: "old short three",
      }),
    ];

    const engine = createMemoryForgettingEngine({ storage });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: false });
    const summaryId = storage.summaries[0]?.summaryId;

    expect(result.deprecatedRecords).toBe(3);
    expect(result.deprecationDiagnostics).toEqual([
      expect.objectContaining({
        summaryId,
        status: "persisted",
        plannedRecordIds: ["s1", "s2", "s3"],
        plannedCount: 3,
        persistedCount: 3,
        reasonCodes: expect.arrayContaining(["persisted"]),
      }),
    ]);
    expect(storage.events).toEqual([
      "saveSummaries",
      "deprecateRecords",
      "transitionRecords",
    ]);
    expect(storage.deprecateInputs).toEqual([
      expect.objectContaining({
        userId: "u1",
        ids: ["s1", "s2", "s3"],
        deprecatedAt: now,
        reason: `summarized_into:${summaryId}`,
        supersededBySummaryId: summaryId,
      }),
    ]);
    expect(
      storage.records.map((record) => ({
        id: record.id,
        tier: record.tier,
        deprecatedAt: record.deprecatedAt,
        supersededBySummaryId: record.supersededBySummaryId,
      })),
    ).toEqual([
      {
        id: "s1",
        tier: "mid",
        deprecatedAt: now,
        supersededBySummaryId: summaryId,
      },
      {
        id: "s2",
        tier: "mid",
        deprecatedAt: now,
        supersededBySummaryId: summaryId,
      },
      {
        id: "s3",
        tier: "mid",
        deprecatedAt: now,
        supersededBySummaryId: summaryId,
      },
    ]);
  });

  it("can disable runtime deprecation without blocking transitions", async () => {
    const storage = new InMemoryStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    storage.records = ["s1", "s2", "s3"].map((id, index) =>
      createRecord({
        id,
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + (index + 1) * 1_000,
      }),
    );

    const engine = createMemoryForgettingEngine({
      storage,
      deprecation: { enabled: false },
    });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: false });

    expect(result.transitionedRecords).toBe(3);
    expect(result.deprecatedRecords).toBe(0);
    expect(result.deprecationDiagnostics).toEqual([
      expect.objectContaining({
        status: "disabled",
        plannedRecordIds: ["s1", "s2", "s3"],
        reasonCodes: ["persistence_disabled"],
      }),
    ]);
    expect(storage.deprecateCalls).toBe(0);
    expect(storage.records.every((record) => record.tier === "mid")).toBe(true);
    expect(
      storage.records.every((record) => record.deprecatedAt === undefined),
    ).toBe(true);
  });

  it("reports no-op diagnostics when the adapter lacks deprecateRecords", async () => {
    const backing = new InMemoryStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    backing.records = ["s1", "s2", "s3"].map((id, index) =>
      createRecord({
        id,
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + (index + 1) * 1_000,
      }),
    );
    const storage: MemoryStorageAdapter = {
      acquireLock: backing.acquireLock.bind(backing),
      releaseLock: backing.releaseLock.bind(backing),
      listCandidates: backing.listCandidates.bind(backing),
      saveSummaries: backing.saveSummaries.bind(backing),
      transitionRecords: backing.transitionRecords.bind(backing),
      archiveRecordDetails: backing.archiveRecordDetails.bind(backing),
      queryRaw: backing.queryRaw.bind(backing),
      querySummaries: backing.querySummaries.bind(backing),
    };

    const engine = createMemoryForgettingEngine({ storage });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: false });

    expect(result.transitionedRecords).toBe(3);
    expect(result.deprecatedRecords).toBe(0);
    expect(result.deprecationDiagnostics).toEqual([
      expect.objectContaining({
        status: "no-op",
        plannedRecordIds: ["s1", "s2", "s3"],
        reasonCodes: ["adapter_missing_deprecate_records"],
      }),
    ]);
    expect(backing.records.every((record) => record.tier === "mid")).toBe(true);
    expect(
      backing.records.every((record) => record.deprecatedAt === undefined),
    ).toBe(true);
  });

  it("continues transitions when deprecation adapter fails", async () => {
    class ThrowingDeprecateStorageAdapter extends InMemoryStorageAdapter {
      async deprecateRecords(
        input: MemoryDeprecateRecordsInput,
      ): Promise<number> {
        this.deprecateCalls += 1;
        this.deprecateInputs.push(input);
        this.events.push("deprecateRecords");
        throw new Error("deprecate failed");
      }
    }

    const storage = new ThrowingDeprecateStorageAdapter();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const shortWindowStart =
      Math.floor(
        (now - DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs - 2 * dayMs) /
          DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      ) * DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short;
    storage.records = ["s1", "s2", "s3"].map((id, index) =>
      createRecord({
        id,
        userId: "u1",
        tier: "short",
        timestamp: shortWindowStart + (index + 1) * 1_000,
      }),
    );

    const engine = createMemoryForgettingEngine({ storage });
    const result = await engine.runCycle({ userId: "u1", now, dryRun: false });

    expect(result.transitionedRecords).toBe(3);
    expect(result.deprecatedRecords).toBe(0);
    expect(result.deprecationDiagnostics).toEqual([
      expect.objectContaining({
        status: "failed",
        plannedRecordIds: ["s1", "s2", "s3"],
        reasonCodes: ["adapter_error"],
        error: {
          name: "Error",
          message: "deprecate failed",
        },
      }),
    ]);
    expect(storage.events).toEqual([
      "saveSummaries",
      "deprecateRecords",
      "transitionRecords",
    ]);
    expect(storage.records.every((record) => record.tier === "mid")).toBe(true);
    expect(
      storage.records.every((record) => record.deprecatedAt === undefined),
    ).toBe(true);
  });
});

describe("memory query api", () => {
  it("returns empty semantic recall when the storage has no vector recall adapter", async () => {
    const storage: MemoryStorageAdapter = {
      acquireLock: async () => null,
      releaseLock: async () => {},
      listCandidates: async () => [],
      saveSummaries: async () => {},
      transitionRecords: async () => {},
      queryRaw: async () => ({ items: [], hasMore: false }),
      querySummaries: async () => ({ items: [], hasMore: false }),
    };

    const api = createMemoryQueryApi({ storage });
    const result = await api.semanticRecall({
      userId: "u1",
      queryEmbedding: [1, 0],
      limit: 5,
    });

    expect(result.items).toEqual([]);
    expect(result.rawCount).toBe(0);
  });

  it("recalls semantic raw memory and marks hits as accessed", async () => {
    const rawRecords = [
      createRecord({ id: "semantic-1", userId: "u1", timestamp: 2000 }),
      createRecord({ id: "semantic-2", userId: "u1", timestamp: 1000 }),
    ];

    let semanticRecallCount = 0;
    let markAccessCount = 0;

    const storage: MemoryStorageAdapter = {
      acquireLock: async () => null,
      releaseLock: async () => {},
      listCandidates: async () => [],
      saveSummaries: async () => {},
      transitionRecords: async () => {},
      queryRaw: async () => ({ items: [], hasMore: false }),
      querySummaries: async () => ({ items: [], hasMore: false }),
      semanticRecallRaw: async (query) => {
        semanticRecallCount += 1;
        expect(query).toMatchObject({
          userId: "u1",
          queryEmbedding: [1, 0],
          limit: 1,
          threshold: 0.5,
        });
        return [
          { record: rawRecords[0], similarity: 0.95 },
          { record: rawRecords[1], similarity: 0.8 },
        ];
      },
      markRecordsAccessed: async (input) => {
        markAccessCount += 1;
        expect(input.userId).toBe("u1");
        expect(input.ids).toEqual(["semantic-1"]);
      },
    };

    const api = createMemoryQueryApi({ storage });
    const result = await api.semanticRecall({
      userId: "u1",
      queryEmbedding: [1, 0],
      limit: 1,
      threshold: 0.5,
    });

    expect(semanticRecallCount).toBe(1);
    expect(markAccessCount).toBe(1);
    expect(result.rawCount).toBe(1);
    expect(result.items).toEqual([
      {
        sourceType: "raw",
        timestamp: 2000,
        record: rawRecords[0],
        similarity: 0.95,
      },
    ]);
  });

  it("does not query summaries when raw results are sufficient", async () => {
    const rawRecords = [
      createRecord({ id: "r1", userId: "u1", timestamp: 2000 }),
      createRecord({ id: "r2", userId: "u1", timestamp: 1000 }),
    ];

    let summaryQueryCount = 0;
    let markAccessCount = 0;

    const storage: MemoryStorageAdapter = {
      acquireLock: async () => null,
      releaseLock: async () => {},
      listCandidates: async () => [],
      saveSummaries: async () => {},
      transitionRecords: async () => {},
      queryRaw: async () => ({ items: rawRecords, hasMore: false }),
      querySummaries: async () => {
        summaryQueryCount += 1;
        return { items: [], hasMore: false };
      },
      markRecordsAccessed: async () => {
        markAccessCount += 1;
      },
    };

    const api = createMemoryQueryApi({ storage });
    const result = await api.queryWithFallback({
      userId: "u1",
      pageSize: 2,
      minRawResultsWithoutFallback: 2,
    });

    expect(result.rawCount).toBe(2);
    expect(result.summaryCount).toBe(0);
    expect(summaryQueryCount).toBe(0);
    expect(markAccessCount).toBe(1);
    expect(result.items[0]?.sourceType).toBe("raw");
  });

  it("queries summaries when raw results are insufficient", async () => {
    const rawRecords = [
      createRecord({ id: "r1", userId: "u1", timestamp: 1000 }),
    ];
    const summaries: MemorySummary[] = [
      {
        summaryId: "s1",
        userId: "u1",
        summaryTier: "L2",
        sourceTier: "mid",
        startTimestamp: 100,
        endTimestamp: 3000,
        messageCount: 4,
        sourceRecordIds: ["a", "b", "c", "d"],
        keyPoints: ["k1"],
        keywords: ["foo"],
        summaryText: "summary text",
        createdAt: 100,
        updatedAt: 100,
      },
    ];

    let summaryQueryCount = 0;
    const storage: MemoryStorageAdapter = {
      acquireLock: async () => null,
      releaseLock: async () => {},
      listCandidates: async () => [],
      saveSummaries: async () => {},
      transitionRecords: async () => {},
      queryRaw: async () => ({ items: rawRecords, hasMore: false }),
      querySummaries: async () => {
        summaryQueryCount += 1;
        return { items: summaries, hasMore: false };
      },
      markRecordsAccessed: async () => {},
    };

    const api = createMemoryQueryApi({ storage });
    const result = await api.queryWithFallback({
      userId: "u1",
      pageSize: 3,
      minRawResultsWithoutFallback: 2,
    });

    expect(summaryQueryCount).toBe(1);
    expect(result.rawCount).toBe(1);
    expect(result.summaryCount).toBe(1);
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.sourceType).toBe("summary");
    expect(result.items[1]?.sourceType).toBe("raw");
  });
});
