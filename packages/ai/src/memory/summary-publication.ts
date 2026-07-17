type MemorySummaryDimensions = Record<
  string,
  string | number | boolean | undefined
>;

interface MemorySummaryPublicationCarrier {
  dimensions?: MemorySummaryDimensions;
}

const PUBLICATION_DIMENSION = "__openloomiMemoryPublication";
const PENDING_PUBLICATION = "pending";

export function isMemorySummaryPublicationPending(
  summary: MemorySummaryPublicationCarrier,
): boolean {
  return summary.dimensions?.[PUBLICATION_DIMENSION] === PENDING_PUBLICATION;
}

// Keep the publication marker in existing JSON dimensions to avoid a storage migration.
export function stageMemorySummaryPublication<
  T extends MemorySummaryPublicationCarrier,
>(summary: T): T {
  return {
    ...summary,
    dimensions: {
      ...(summary.dimensions ?? {}),
      [PUBLICATION_DIMENSION]: PENDING_PUBLICATION,
    },
  };
}

export function publishMemorySummary<T extends MemorySummaryPublicationCarrier>(
  summary: T,
): T {
  const dimensions = { ...(summary.dimensions ?? {}) };
  delete dimensions[PUBLICATION_DIMENSION];
  return {
    ...summary,
    dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
  };
}
