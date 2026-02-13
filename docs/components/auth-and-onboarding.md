# Auth and Onboarding

## Purpose

Provide contributor-friendly credential setup and runtime credential resolution.

## Key Files

- `/Users/eric/code/llm-council/src/onboarding/onboard.ts`
- `/Users/eric/code/llm-council/src/auth/credentials.ts`
- `/Users/eric/code/llm-council/.council/credentials.json` (runtime, gitignored)

## Auth Modes

- `credential-ref` (recommended)
- `api-key-env` (legacy)
- `oauth-device-code`
- `command`

## Onboarding Flow

1. Read config and compute required credential IDs.
2. Prompt per credential:
   - OAuth login when supported (`pi-ai` OAuth providers).
   - fallback API key entry.
3. Persist credentials to local store.
4. Rewrite config member auth blocks to `credential-ref`.

## OAuth Notes

- OpenAI Codex OAuth is supported via `pi-ai` provider `openai-codex`.
- Stored OAuth credentials are refreshed on demand during runtime resolution.

## Contributor Touchpoints

- Add provider mapping in onboarding (`OAUTH_PROVIDER_BY_MODEL_PROVIDER`) for new providers.
- Keep credential store schema backwards-compatible.
- Keep `.gitignore` aligned with credential store paths.
