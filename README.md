# Roundtable (TypeScript Scaffold)

A self-hosted council runtime for structured multi-agent deliberation with:

- Odd-member councils with configurable roles, traits, and focus weights.
- Round-robin town-hall turns.
- Turn actions: `CONTRIBUTE`, `PASS`, `CALL_VOTE`.
- Motion seconding and blind voting.
- Phase-configurable voting thresholds and abstention handling.
- Structured per-member memory (`MEMORY.json`) with rendered markdown snapshots.
- Full session recording and review artifacts.
- Final leader summary entry.
- Execution handoff artifact with human-approval gating.

Contributor docs: see [`docs/README.md`](docs/README.md).

## Protocol Rules Implemented

1. Each member gets one turn per round.
2. Sessions run through a configurable phase graph from `sessionPolicy.entryPhaseId`.
3. Each phase controls its own rounds, governance, fallback behavior, and transitions.
4. Members receive a phase-context packet in prompts (current phase + distilled graph + progress hints).
5. Final output artifact type is configured in `output.type` (`none` or `documentation`).
6. Turn order is deterministic (`turnOrder` when set, else member declaration order).
7. `CALL_VOTE` pauses discussion for seconding.
8. If no second, discussion resumes.
9. If seconded, blind ballots are collected in parallel.
10. Motion pass thresholds are phase-configurable (`governance.majorityThreshold`, `abstainCountsAsNo`).
11. If a phase reaches round limit, configured fallback and transition rules decide next step.
12. For `output.type=documentation`, leader draft is council-reviewed: approval vote -> blocker feedback (on failure) -> leader revision -> re-vote (bounded).

Session policy config example:

```json
{
  "sessionPolicy": {
    "entryPhaseId": "high_level",
    "maxPhaseTransitions": 8,
    "phaseContextVerbosity": "standard"
  },
  "phases": [
    {
      "id": "high_level",
      "goal": "Define solution boundaries and success metrics",
      "stopConditions": { "maxRounds": 5, "endOnMajorityVote": true },
      "fallback": {
        "resolution": "No majority high-level direction reached within configured rounds.",
        "action": "END_SESSION"
      },
      "transitions": [{ "to": "implementation", "when": "MAJORITY_VOTE", "priority": 0 }]
    }
  ],
  "output": {
    "type": "documentation"
  },
  "documentationReview": {
    "maxRevisionRounds": 2
  },
  "turnOrder": ["cust_outcomes", "scalability", "delivery_realist"]
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
- `documentation.md` (when approved): final markdown deliverable.
- `documentation.draft.vN.md` (when `output.type=documentation`): leader draft and revisions.
- `documentation.review.vN.json` (when approval vote fails): structured blocker/suggestion feedback.
- `documentation.unapproved.md` (when review loop exhausts without approval): final unapproved draft.
- `documentation.unresolved-blockers.json` (when unapproved): remaining blockers from latest failed review round.
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
