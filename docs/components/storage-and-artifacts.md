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
  - `documentation.md` (approved final, when `outputType=documentation`)
  - `documentation.draft.vN.md` (leader draft/revisions in review loop)
  - `documentation.review.vN.json` (structured council feedback after failed doc approval vote)
  - `documentation.unapproved.md` (when review loop ends without approval)
  - `documentation.unresolved-blockers.json` (remaining blockers for unapproved drafts)
  - `execution-handoff.json` (when execution is requested)

## Write Strategy

- Session event log writes happen incrementally in the recorder.
- Member/council memory is updated once at session close from final outcomes and event-derived signals.
- `*.json` memory files are canonical; `*.md` files are deterministic renderings of those JSON files.
- Member prompt context is computed from active records scoped to the most recent 25 session IDs (older records remain stored but fade from prompt influence).
- Session finalization writes resolved state and artifact pointers.
- Documentation review loop writes draft/review artifacts per revision and only emits `documentation.md` when approval vote passes.

## Memory Behavior

- Member memory keeps a bounded active record set (`MEMORY.json`) and a bounded recent-session digest list.
- Prompt context is rebuilt from active records after each session close and is what gets injected into turn prompts.
- "Fade" behavior means:
  - Records tied only to older sessions fall out of prompt context after the most recent 25 sessions.
  - Those records remain on disk in memory JSON/markdown and are not deleted.
- This preserves long-term auditability while biasing model context toward recent, relevant lessons.

## Contributor Touchpoints

- When adding new artifact types:
  1. Add artifact path in recorder/orchestrator result.
  2. Add write step in orchestrator finalization.
  3. Document it in README and `docs/`.

- Keep file formats deterministic (JSON or markdown) for tooling compatibility.
