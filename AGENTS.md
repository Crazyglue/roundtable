# AGENTS.md

## Project Maintenance Rules

1. Keep example configs in sync with runtime behavior.
2. After any change to config schema, auth behavior, provider wiring, or required fields, update:
   - `/Users/eric/code/llm-council/council.config.example.json`
   - `/Users/eric/code/llm-council/README.md` config examples (if affected)
3. Validate changed JSON examples parse successfully before finishing.
