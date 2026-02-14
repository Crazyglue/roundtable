# Council Engine

## Purpose

Run the council protocol from start to finish, including:

- leader election
- configurable phase-graph deliberation
- motions, seconding, voting
- final leader summary
- optional output artifact generation
- session-close memory refresh

## Key Files

- `src/council/orchestrator.ts`
- `src/council/prompts.ts`

## Protocol

1. `SESSION_STARTED`
2. Leader election ballots -> `LEADER_ELECTED`
3. Start at `sessionPolicy.entryPhaseId`; for each phase:
   - `PASS_STARTED`
   - for each round/member: `TURN_ACTION`
   - if motion called: seconding + voting
4. `PASS_COMPLETED` and resolve next phase from transition/fallback config.
5. Generate leader summary.
6. Optionally run documentation review loop (`output.type=documentation`):
   - leader writes draft (`documentation.draft.v1.md`)
   - council blind approval vote
   - if failed, non-YES members submit critical blockers + suggested changes
   - leader revises and council re-votes (bounded by `documentationReview.maxRevisionRounds`)
   - approved draft is written as `documentation.md`
7. Write `SESSION_CLOSED` and refresh memory state from session outcomes.

## Round-Robin Semantics

- Turn order comes from `turnOrder` config (or member declaration order when omitted).
- In each phase, each round gives exactly one turn to each member in turn-order sequence.
- `CALL_VOTE` interrupts discussion to run seconding/voting, then returns to discussion unless the motion passes.
- Round limits are phase-scoped from `phase.stopConditions.maxRounds`.
- Vote pass/fail is phase-scoped from `phase.governance`.
- Next phase is selected from configured `transitions` filtered by phase outcome (`MAJORITY_VOTE`, `ROUND_LIMIT`, or `ALWAYS`).
- On round-limit without matching transition, `phase.fallback` determines whether to end or force a transition.
- Prompts include a phase context packet (current phase, graph digest, progress, legal transitions).
- Documentation approval is separate from motion voting and uses the same full-council majority rule.

## Error Handling

- Non-JSON model responses:
  - logged with context
  - normalized into deterministic fallback actions
- Model/provider/auth failures:
  - logged
  - session fails fast

## Extension Points

- Add new output types in:
  - `OutputConfig.type` (`src/types.ts`)
  - config schema in `src/config.ts`
  - orchestration finalization branch (`src/council/orchestrator.ts`)
  - prompts and normalizers (`src/council/prompts.ts`)
- Adjust voting semantics in `computeVotePass()`.
