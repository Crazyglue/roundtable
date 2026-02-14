# AGENTS.md

## Project Overview
Roundtable is a self-hosted TypeScript council runtime for multi-agent deliberation.

- Protocol: round-robin discussion, motion seconding, blind voting, majority-of-full-council decisions.
- Deliberation flow: two passes (`HIGH_LEVEL` then `IMPLEMENTATION`) with configurable round limits.
- Outputs: transcript/events/session state, leader summary, optional documentation artifact with council review loop.
- Memory: council + per-member structured memory persisted under `.council/memory/`.

Start here for architecture and behavior details:
- [`docs/README.md`](docs/README.md)
- [`docs/system-overview.md`](docs/system-overview.md)
- [`docs/components/council-engine.md`](docs/components/council-engine.md)
- [`docs/components/storage-and-artifacts.md`](docs/components/storage-and-artifacts.md)

## Common Commands (Verified)
The commands below are implemented in `package.json` and `src/index.ts`.

1. Install dependencies
```bash
npm install
```

2. Build TypeScript to `dist/`
```bash
npm run build
```

3. Type-check without emitting files
```bash
npm run check
```

4. Run onboarding (writes credential refs to config)
```bash
npm run start -- onboard --config council.config.json
# shortcut script:
npm run onboard
```

5. Run a council session
```bash
npm run start -- run --config council.config.json --prompt "Design a quota-aware job scheduler"
```

6. Generate documentation output artifact
```bash
npm run start -- run --config council.config.json --output-type documentation --prompt "Design a quota-aware job scheduler"
```

7. Mark execution handoff as approved at run time
```bash
npm run start -- run --config council.config.json --prompt "..." --approve-execution
```

CLI/config reference:
- [`docs/components/cli-and-config.md`](docs/components/cli-and-config.md)
- [`README.md`](README.md)

## Code Style and Conventions
- Language/runtime: TypeScript + Node ESM.
  - `tsconfig.json` uses `"strict": true`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`.
- Keep source code in `src/`; compiled output goes to `dist/` (`npm run build`).
- Use ESM import style consistent with current codebase (local imports include `.js` extension in TS source, e.g. `import { loadConfig } from "./config.js";`).
- Keep changes scoped and deterministic for council state transitions and artifact generation.
- If you change behavior, update docs and examples in the same PR (see maintenance rules below).

Contributor docs map:
- [`docs/components/model-runtime.md`](docs/components/model-runtime.md)
- [`docs/components/auth-and-onboarding.md`](docs/components/auth-and-onboarding.md)

## Tech Stack
- TypeScript (`^5.7.3`) + Node.js (ES2022 target, NodeNext modules)
- Model runtime: [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)
- Storage: local filesystem JSON/Markdown artifacts under `.council/`
- Config: `council.config.json` (see `council.config.example.json`)

## Maintenance Rules (Required)
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
   - Example: `node -e 'JSON.parse(require("fs").readFileSync("council.config.example.json","utf8")); console.log("ok")'`
