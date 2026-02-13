# AGENTS.md

## Project Maintenance Rules

1. Keep example configs in sync with runtime behavior.
2. After any change to config schema, auth behavior, provider wiring, or required fields, update:
   - `council.config.example.json`
   - `README.md` config examples (if affected)
3. Keep contributor docs in sync with implementation.
4. After any change to CLI behavior, council protocol, model runtime, auth/onboarding, storage, or output artifacts, update:
   - relevant files under `docs/`
   - `docs/README.md` index links when adding/removing docs pages
   - `README.md` command/usage sections when affected
5. Validate changed JSON examples parse successfully before finishing.
