# Contributor Docs

This folder contains high-level architecture and component docs for contributors.

## Components

- [System Overview](/Users/eric/code/llm-council/docs/system-overview.md)
- [CLI and Config](/Users/eric/code/llm-council/docs/components/cli-and-config.md)
- [Council Engine](/Users/eric/code/llm-council/docs/components/council-engine.md)
- [Model Runtime](/Users/eric/code/llm-council/docs/components/model-runtime.md)
- [Auth and Onboarding](/Users/eric/code/llm-council/docs/components/auth-and-onboarding.md)
- [Storage and Artifacts](/Users/eric/code/llm-council/docs/components/storage-and-artifacts.md)

## Suggested Reading Order

1. System overview
2. CLI/config
3. Council engine
4. Model runtime
5. Auth/onboarding
6. Storage/artifacts

## Contribution Guidance

When you modify behavior in a component:

1. Update its doc in this folder.
2. Update `council.config.example.json` if schema/behavior changed.
3. Update root `README.md` run instructions if commands/flags changed.
