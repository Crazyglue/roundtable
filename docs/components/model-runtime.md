# Model Runtime

## Purpose

Abstract LLM calls behind a single interface used by the orchestrator.

## Key Files

- `/Users/eric/code/llm-council/src/models/modelClient.ts`
- `/Users/eric/code/llm-council/src/models/factory.ts`
- `/Users/eric/code/llm-council/src/models/piAiClient.ts`

## Current Implementation

- All provider interactions are routed through `@mariozechner/pi-ai`.
- Provider-to-API defaults:
  - `openai` / `openai-compatible` -> `openai-completions`
  - `anthropic` -> `anthropic-messages`
  - `openai-codex` -> `openai-codex-responses`

## Response Handling

- `completeText()` returns text for orchestrator prompts.
- `completeJson()` extracts/repairs JSON text and parses it.
- Parse errors are wrapped as `JsonResponseParseError`.

## Important Runtime Behavior

- Codex responses do not accept `temperature`; the adapter omits it.
- Provider errors are logged with provider/model/api/baseUrl context.

## Extension Points

- Add provider mappings in `resolveApi()`.
- Add provider-specific options in `completeText()` (conditional by API).
- Adjust JSON extraction behavior in `/Users/eric/code/llm-council/src/utils.ts`.
