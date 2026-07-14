# Memory Graph Rollout Governance

This note defines the review gate for enabling Memory Graph Evolution beyond
dry-run comparison. It is not a scheduler, UI, storage migration, or automatic
mutation path.

## Inputs

The rollout gate consumes either persisted runtime evidence or compatible
dry-run artifacts:

- consolidation evaluation metrics
- graph-aware retrieval scenario results
- semantic retrieval eval scenario reports
- persisted correction and rollback operation identities, with command dry-runs
  retained as a compatibility input
- polluted-memory audit scenario reports

## Required Gates

- Consolidation must preserve expected stable clusters.
- Duplicate or noisy clusters must not be promoted.
- Temporary overrides must not leak into stable memory.
- Contested clusters must remain visible for review.
- Decay decisions must match expected stale clusters.
- Default graph retrieval must hide superseded raw records.
- Audit retrieval must recover the source chain.
- No cross-scope node may appear in ranked, hidden, or audit results.
- Polluted memory scenarios must be resolved by a valid dry-run command.
- At least one correction command and one rollback command must be available
  before limited rollout.

## Correction Model

Corrections are explicit, owner-scoped, versioned graph commands. Runtime
corrections can change membership, lifecycle, or preferred representation and
can persist corrected summary content. Prior nodes, edges, and operation history
remain available for audit. Dry-run command reports remain supported for review,
but they do not satisfy runtime-evidence gates when persisted evidence is
provided.

## Rollback Rules

Rollback is available only when the persisted graph exposes source provenance.
Runtime rollback first restores graph visibility, then restores matching raw
soft-deprecation fields, and only then retires the representative and
supersession edges. Missing restoration capability or a partial failure leaves
the active representative available and returns retryable diagnostics.

## Rollout Decision

`buildMemoryGraphRolloutGovernanceReport` returns:

- `ready-for-limited-rollout` when every gate passes
- `blocked` when any gate fails

The report is intentionally conservative. Missing semantic, polluted-memory,
correction, rollback, or audit evidence produces `blocked`; feature presence
alone cannot authorize broader runtime enablement.
