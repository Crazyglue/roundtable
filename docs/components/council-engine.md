# Council Engine

## Purpose

Run the council protocol from start to finish, including:

- leader election
- turn-based deliberation
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
3. For each round/member:
   - `TURN_ACTION`
   - if motion called: seconding + voting
4. Close via majority vote or round limit.
5. Generate leader summary.
6. Optionally generate output artifact (`documentation.md`).
7. Write `SESSION_CLOSED` and refresh memory state from session outcomes.

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
