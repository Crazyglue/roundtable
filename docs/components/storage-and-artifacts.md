# Storage and Artifacts

## Purpose

Persist all deliberation state so sessions are auditable and memory can accumulate.

## Key Files

- `src/storage/memoryStore.ts`
- `src/storage/sessionRecorder.ts`

## Directory Layout

- `.council/memory/`
  - `COUNCIL.md`
  - `<member_id>/AGENT.md`
  - `<member_id>/MEMORY.md`
- `.council/sessions/<session_id>/`
  - `transcript.md`
  - `events.json`
  - `session.json`
  - `leader-summary.md`
  - `documentation.md` (when `outputType=documentation`)
  - `execution-handoff.json` (when execution is requested)

## Write Strategy

- Event log writes happen incrementally.
- Memory updates happen for each event and final summaries.
- Session finalization writes resolved state and artifact pointers.

## Contributor Touchpoints

- When adding new artifact types:
  1. Add artifact path in recorder/orchestrator result.
  2. Add write step in orchestrator finalization.
  3. Document it in README and `docs/`.

- Keep file formats deterministic (JSON or markdown) for tooling compatibility.
