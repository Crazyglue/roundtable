# Contributor Docs

This folder contains high-level architecture and component docs for contributors.

## Components

- [System Overview](./system-overview.md)
- [CLI and Config](./components/cli-and-config.md)
- [Council Engine](./components/council-engine.md)
- [Model Runtime](./components/model-runtime.md)
- [Auth and Onboarding](./components/auth-and-onboarding.md)
- [Storage and Artifacts](./components/storage-and-artifacts.md)

## Examples

- `docs/examples/` contains captured session artifacts (transcript/events/session state/output docs) from an earlier run; useful for artifact format reference.

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
