# System Overview

This project runs a structured multi-agent "council" over a user prompt and can emit:

- a deliberation transcript and event log
- a leader summary
- optional output artifacts (for example, documentation markdown)
- optional execution handoff metadata

## Runtime Flow

1. CLI parses command and options (`run` or `onboard`).
2. Config is loaded and validated.
3. On `run`, orchestrator starts a new session:
   - leader election
   - high-level pass (`HIGH_LEVEL`)
   - automatic continuation vote if high-level hits round limit
   - implementation pass (`IMPLEMENTATION`) only when continuation vote passes
   - round-robin discussion within each pass
   - motion seconding
   - blind voting
   - finalization
4. Session events are written incrementally and memory is refreshed at close from session outcomes.
5. Session artifacts are written to `.council/sessions/<session_id>/`.

Round-robin details:
- Turn order is fixed per session (`turnOrder` or member declaration order).
- Each pass executes full rounds where every member receives one turn.
- A pass closes by majority vote or by hitting its configured round cap.
- If high-level closes by round cap, a majority continuation vote determines whether implementation runs.

## High-Level Architecture

```mermaid
flowchart TD
  A["CLI (src/index.ts)"] --> B["Config (src/config.ts)"]
  A --> C["Onboarding (src/onboarding/onboard.ts)"]
  B --> D["Council Orchestrator (src/council/orchestrator.ts)"]
  D --> E["Prompt/Normalization (src/council/prompts.ts)"]
  D --> F["Model Layer (src/models/*)"]
  D --> G["Auth/Credentials (src/auth/credentials.ts)"]
  D --> H["Storage (src/storage/*)"]
  H --> I["Session Artifacts (.council/sessions/*)"]
  H --> J["Memory Files (.council/memory/*)"]
```

## Core Design Decisions

- Odd council size, majority of full council for pass.
- Two-pass deliberation (high-level then implementation) with independently configurable round limits.
- Deterministic fallbacks for non-JSON model output.
- Fail-fast for transport/auth/provider errors.
- Human approval gate for execution handoff.
- Credentials stored locally in gitignored files and referenced by ID.
