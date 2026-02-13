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
  - Optional: `--approve-execution`, `--output-type documentation`
  - Prompt tag alternative: `[output:documentation] ...`
- `onboard`
  - Required: `--config`
  - Optional: `--credentials`

## Config Notes

- `members[]` must be odd count and >= 3.
- Each member has `model` config with provider/model/base URL.
- Auth is typically `credential-ref` after onboarding.

## Contributor Touchpoints

Update config validation when:

1. New model/provider fields are added.
2. New auth methods are added.
3. New session options/flags are added.
