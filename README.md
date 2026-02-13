# Roundtable (TypeScript Scaffold)

A self-hosted council runtime for structured multi-agent deliberation with:

- Odd-member councils with configurable roles, traits, and focus weights.
- Round-robin town-hall turns.
- Turn actions: `CONTRIBUTE`, `PASS`, `CALL_VOTE`.
- Motion seconding and blind voting.
- Majority-of-full-council voting (`ABSTAIN` effectively counts as `NO`).
- Structured per-member memory (`MEMORY.json`) with rendered markdown snapshots.
- Full session recording and review artifacts.
- Final leader summary entry.
- Execution handoff artifact with human-approval gating.

Contributor docs: see [`docs/README.md`](docs/README.md).

## Protocol Rules Implemented

1. Each member gets one turn per round.
2. Sessions run in two passes: `HIGH_LEVEL` then `IMPLEMENTATION`.
3. Rounds are configurable per pass (`deliberation.highLevelRounds` and `deliberation.implementationRounds`, defaults 5/5).
4. Members are aware of pass objective and remaining rounds/turns in prompts.
5. Turn order is deterministic (`turnOrder` when set, else member declaration order).
6. `CALL_VOTE` pauses discussion for seconding.
7. If no second, discussion resumes.
8. If seconded, blind ballots are collected in parallel.
9. Motion passes only with strict majority of full council.
10. If no passing motion by round limit, that pass closes by limit and the session continues to the next pass.

Deliberation config example:

```json
{
  "deliberation": {
    "highLevelRounds": 5,
    "implementationRounds": 5
  }
}
```

## Layout

- `src/index.ts`: CLI entrypoint.
- `src/council/orchestrator.ts`: state machine and orchestration loop.
- `src/council/prompts.ts`: strict prompt contracts + response normalizers.
- `src/models/*`: model adapter abstraction and providers.
- `src/storage/*`: memory/session persistence.
- `council.config.example.json`: starter config.

## Run

1. Install dependencies:

```bash
npm install
```

2. Copy example config:

```bash
cp council.config.example.json council.config.json
```

3. Run onboarding (recommended):

```bash
npm run start -- onboard --config council.config.json
# or: npm run onboard
```

4. Run a session:

```bash
npm run build
npm run start -- run --config council.config.json --prompt "Review the architecture direction for multi-tenant event ingestion."
```

5. Optional structured output artifact:

```bash
npm run start -- run --config council.config.json --output-type documentation --prompt "Create a system design for a tiny-url app"
# alternatively inline in prompt:
npm run start -- run --config council.config.json --prompt "[output:documentation] Create a system design for a tiny-url app"
```

6. Optional execution approval:

```bash
npm run start -- run --config council.config.json --prompt "..." --approve-execution
```

## Artifacts

Under `storage.rootDir/sessions/<session_id>/`:

- `transcript.md`: reviewable text record.
- `events.json`: structured event log.
- `session.json`: final state payload.
- `leader-summary.md`: final leader entry.
- `documentation.md` (when `outputType=documentation`): full markdown deliverable generated from the discussion.
- `execution-handoff.json` (when needed): executor payload with approval status.

Under `storage.memoryDir/`:

- `COUNCIL.md`: council-level historical memory.
- `COUNCIL.json`: canonical structured council memory.
- `<member_id>/AGENT.md`: member profile.
- `<member_id>/MEMORY.json`: canonical structured member memory records + prompt context.
- `<member_id>/MEMORY.md`: rendered memory snapshot from `MEMORY.json`.
- Prompt context fades older session evidence after the most recent 25 sessions while retaining full history on disk.

## Notes

- All LLM interactions now go through `@mariozechner/pi-ai` via a unified adapter.
- Default API mapping by `model.provider`:
  - `openai` / `openai-compatible` -> `openai-completions`
  - `anthropic` -> `anthropic-messages`
  - `openai-codex` -> `openai-codex-responses`
- You can override API selection with `model.api` when needed.
- Authentication now supports:
  - `model.auth.method = "credential-ref"` (recommended; resolved from `.council/credentials.json`)
  - `model.apiKeyEnv` (legacy shortcut)
  - `model.auth.method = "api-key-env"`
  - `model.auth.method = "oauth-device-code"` (interactive OAuth device flow + token cache)
  - `model.auth.method = "command"` (run a helper command that returns a token on stdout)
- Onboarding writes credentials to `.council/credentials.json` (gitignored) and rewrites config auth blocks to `credential-ref`.
- OAuth tokens are cached by default at `~/.roundtable/tokens.json` (override with `tokenStorePath`).
- Direct OpenAI/Anthropic API usage remains key-oriented; OAuth is mainly useful for compatible gateways or broker/helper flows.
- This scaffold does not execute code changes yet. It emits execution handoff data and enforces approval gating.

## Auth Config Examples

Credential reference (recommended):

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.1-codex-mini",
  "baseUrl": "https://chatgpt.com/backend-api",
  "auth": {
    "method": "credential-ref",
    "credentialId": "openai-codex"
  }
}
```

API key env (legacy):

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4.1",
  "auth": {
    "method": "api-key-env",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

OAuth device flow:

```json
{
  "provider": "openai-compatible",
  "model": "my-gateway-model",
  "baseUrl": "https://gateway.example.com/v1",
  "auth": {
    "method": "oauth-device-code",
    "clientId": "my-client-id",
    "deviceAuthorizationEndpoint": "https://auth.example.com/oauth/device/code",
    "tokenEndpoint": "https://auth.example.com/oauth/token",
    "scopes": ["models:inference"],
    "cacheKey": "gateway-prod"
  }
}
```

Codex-style provider (via `openai-codex-responses` mapping):

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.1-codex-mini",
  "baseUrl": "https://chatgpt.com/backend-api",
  "auth": {
    "method": "oauth-device-code",
    "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
    "deviceAuthorizationEndpoint": "https://auth.openai.com/oauth/device/code",
    "tokenEndpoint": "https://auth.openai.com/oauth/token",
    "scopes": ["openid", "profile", "email", "offline_access"],
    "cacheKey": "openai-codex-oauth"
  }
}
```

Command-based auth helper:

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4.1",
  "auth": {
    "method": "command",
    "command": "/usr/local/bin/my-token-helper --provider openai",
    "cacheTtlSeconds": 1800
  }
}
```
