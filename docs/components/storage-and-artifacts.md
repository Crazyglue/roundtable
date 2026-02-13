# Storage and Artifacts

## Purpose

Persist all deliberation state so sessions are auditable and memory remains useful across runs.

## Key Files

- `src/storage/memoryStore.ts`
- `src/storage/sessionRecorder.ts`

## Directory Layout

- `.council/memory/`
  - `COUNCIL.json` (canonical structured council memory)
  - `COUNCIL.md` (human-readable council snapshot)
  - `<member_id>/AGENT.md`
  - `<member_id>/MEMORY.json` (canonical structured member memory)
  - `<member_id>/MEMORY.md` (human-readable member memory snapshot)
- `.council/sessions/<session_id>/`
  - `transcript.md`
  - `events.json`
  - `session.json`
  - `leader-summary.md`
  - `documentation.md` (when `outputType=documentation`)
  - `execution-handoff.json` (when execution is requested)

## Write Strategy

- Session event log writes happen incrementally in the recorder.
- Member/council memory is updated once at session close from final outcomes and event-derived signals.
- `*.json` memory files are canonical; `*.md` files are deterministic renderings of those JSON files.
- Session finalization writes resolved state and artifact pointers.

## Contributor Touchpoints

- When adding new artifact types:
  1. Add artifact path in recorder/orchestrator result.
  2. Add write step in orchestrator finalization.
  3. Document it in README and `docs/`.

- Keep file formats deterministic (JSON or markdown) for tooling compatibility.
