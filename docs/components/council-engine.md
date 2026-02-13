# Council Engine

## Purpose

Run the council protocol from start to finish, including:

- leader election
- two-pass turn-based deliberation (`HIGH_LEVEL` then `IMPLEMENTATION`)
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
3. `PASS_STARTED` for `HIGH_LEVEL`; for each round/member:
   - `TURN_ACTION`
   - if motion called: seconding + voting
4. `PASS_COMPLETED` for `HIGH_LEVEL`.
5. `PASS_STARTED` for `IMPLEMENTATION`; repeat round/member loop.
6. `PASS_COMPLETED` for `IMPLEMENTATION`.
7. Generate leader summary.
8. Optionally generate output artifact (`documentation.md`).
   - Documentation output requires explicit known risks and mitigations.
9. Write `SESSION_CLOSED` and refresh memory state from session outcomes.

## Round-Robin Semantics

- Turn order comes from `turnOrder` config (or member declaration order when omitted).
- In each pass, each round gives exactly one turn to each member in turn-order sequence.
- `CALL_VOTE` interrupts discussion to run seconding/voting, then returns to discussion unless the motion passes.
- Round limits are pass-scoped:
  - `HIGH_LEVEL` ends when a motion passes or `deliberation.highLevelRounds` is exhausted.
  - `IMPLEMENTATION` ends when a motion passes or `deliberation.implementationRounds` is exhausted.
- The implementation pass receives the high-level pass resolution as explicit prompt context.

## Error Handling

- Non-JSON model responses:
  - logged with context
  - normalized into deterministic fallback actions
- Model/provider/auth failures:
  - logged
  - session fails fast

## Extension Points

- Add new output types in:
  - `SessionRunOptions.outputType` (`src/types.ts`)
  - orchestration finalization branch (`src/council/orchestrator.ts`)
  - prompts and normalizers (`src/council/prompts.ts`)
- Adjust voting semantics in `computeVotePass()`.
