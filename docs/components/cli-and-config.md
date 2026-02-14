# CLI and Config

## Purpose

Provide a stable entrypoint for users and contributors:

- run council sessions
- onboard credentials
- validate config shape before execution

## Key Files

- `src/index.ts`
- `src/config.ts`
- `src/types.ts`
- `council.config.example.json`

## Commands

- `run`
  - Required: `--config`, `--prompt`
  - Optional: `--approve-execution`
- `onboard`
  - Required: `--config`
  - Optional: `--credentials`

## Config Notes

- `members[]` must be odd count and >= 3.
- `sessionPolicy.entryPhaseId` selects the first phase.
- `sessionPolicy.maxPhaseTransitions` prevents infinite phase loops.
- `sessionPolicy.phaseContextVerbosity` controls how much of the phase graph is injected into prompts.
- `phases[]` defines the deliberation graph with per-phase rules:
  - `stopConditions.maxRounds` and `endOnMajorityVote`
  - `governance` (`requireSeconding`, `majorityThreshold`, `abstainCountsAsNo`)
  - `deliverables`, `qualityGates`, `evidenceRequirements`, `memoryPolicy`
  - `fallback` and `transitions` (directed graph)
- `documentationReview.maxRevisionRounds` bounds documentation revision loops after failed doc approval votes.
- `output.type` defines final artifact behavior for the run (`none` or `documentation`).
- `turnOrder` sets deterministic round-robin order; when omitted, member declaration order is used.
- Each member has `model` config with provider/model/base URL.
- Auth is typically `credential-ref` after onboarding.
- Config parsing/validation is implemented with `zod` plus graph integrity checks (reachable phases, valid transition targets, unique IDs).

## Contributor Touchpoints

Update config validation when:

1. New model/provider fields are added.
2. New auth methods are added.
3. New session options/flags are added.
