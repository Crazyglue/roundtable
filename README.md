# LLM Council (TypeScript Scaffold)

A self-hosted council runtime for structured multi-agent deliberation with:

- Odd-member councils with configurable roles, traits, and focus weights.
- Round-robin town-hall turns.
- Turn actions: `CONTRIBUTE`, `PASS`, `CALL_VOTE`.
- Motion seconding and blind voting.
- Majority-of-full-council voting (`ABSTAIN` effectively counts as `NO`).
- Per-event memory updates for every member.
- Full session recording and review artifacts.
- Final leader summary entry.
- Execution handoff artifact with human-approval gating.

## Protocol Rules Implemented

1. Each member gets one turn per round.
2. Max rounds are configurable (default shown: 5).
3. Members are aware of remaining rounds/turns in prompts.
4. `CALL_VOTE` pauses discussion for seconding.
5. If no second, discussion resumes.
6. If seconded, blind ballots are collected in parallel.
7. Motion passes only with strict majority of full council.
8. If no passing motion by round limit, session closes by limit.

## Layout

- `/Users/eric/code/llm-council/src/index.ts`: CLI entrypoint.
- `/Users/eric/code/llm-council/src/council/orchestrator.ts`: state machine and orchestration loop.
- `/Users/eric/code/llm-council/src/council/prompts.ts`: strict prompt contracts + response normalizers.
- `/Users/eric/code/llm-council/src/models/*`: model adapter abstraction and providers.
- `/Users/eric/code/llm-council/src/storage/*`: memory/session persistence.
- `/Users/eric/code/llm-council/council.config.example.json`: starter config.

## Run

1. Install dependencies:

```bash
npm install
```

2. Copy example config:

```bash
cp council.config.example.json council.config.json
```

3. Set provider keys (examples):

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

4. Run a session:

```bash
npm run build
npm run start -- run --config council.config.json --prompt "Review the architecture direction for multi-tenant event ingestion."
```

5. Optional execution approval:

```bash
npm run start -- run --config council.config.json --prompt "..." --approve-execution
```

## Artifacts

Under `storage.rootDir/sessions/<session_id>/`:

- `transcript.md`: reviewable text record.
- `events.json`: structured event log.
- `session.json`: final state payload.
- `leader-summary.md`: final leader entry.
- `execution-handoff.json` (when needed): executor payload with approval status.

Under `storage.memoryDir/`:

- `COUNCIL.md`: council-level historical memory.
- `<member_id>/AGENT.md`: member profile.
- `<member_id>/MEMORY.md`: rolling notes + session summaries.

## Notes

- All LLM interactions now go through `@mariozechner/pi-ai` via a unified adapter.
- Default API mapping by `model.provider`:
  - `openai` / `openai-compatible` -> `openai-completions`
  - `anthropic` -> `anthropic-messages`
  - `openai-codex` -> `openai-codex-responses`
- You can override API selection with `model.api` when needed.
- Authentication now supports:
  - `model.apiKeyEnv` (legacy shortcut)
  - `model.auth.method = "api-key-env"`
  - `model.auth.method = "oauth-device-code"` (interactive OAuth device flow + token cache)
  - `model.auth.method = "command"` (run a helper command that returns a token on stdout)
- OAuth tokens are cached by default at `~/.llm-council/tokens.json` (override with `tokenStorePath`).
- Direct OpenAI/Anthropic API usage remains key-oriented; OAuth is mainly useful for compatible gateways or broker/helper flows.
- This scaffold does not execute code changes yet. It emits execution handoff data and enforces approval gating.

## Auth Config Examples

API key env:

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
