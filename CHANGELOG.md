# Changelog

## [1.0.2](https://github.com/apinator-io/sdk-mcp/compare/v1.0.1...v1.0.2) (2026-10-17)


### Miscellaneous Chores

* release 1.0.2 ([f19c525](https://github.com/apinator-io/sdk-mcp/commit/f19c52516b76e66df9713e6a4901c78e3ab16116))

## [1.0.1](https://github.com/apinator-io/sdk-mcp/compare/v1.0.0...v1.0.1) (2026-10-17)


### Bug Fixes

* guard the progress callback and export WatchProgress ([da80d35](https://github.com/apinator-io/sdk-mcp/commit/da80d354464990d52f711555b3f56dc78698bd6d))

## 1.0.0 (2026-10-16)


### Features

* initial release ([8720f47](https://github.com/apinator-io/sdk-mcp/commit/8720f4798fab3a3380cc3031e192dfe8fe274473))
* report watch progress and accept array payloads ([b975afb](https://github.com/apinator-io/sdk-mcp/commit/b975afbe15cfb09999eca392e3c155c7e81ad5bd))


### Bug Fixes

* avoid a double period in connection refused errors ([a5f9074](https://github.com/apinator-io/sdk-mcp/commit/a5f90744e2418368624c58e92792df50343f2e33))

## Changelog

## Unreleased

### Added

- MCP server over stdio, runnable with `npx -y @apinator/mcp` (Node 18+).
- Tools: `publish_event`, `list_channels`, `get_channel`, `sign_channel_auth`, `watch_channel`.
- `APINATOR_READ_ONLY=1` mode that removes `publish_event`.
- Resources: the Apinator docs index (`llms.txt`) and a protocol / channel-type reference.
- `add-realtime-feature` prompt.
- Startup validation of `APINATOR_*` environment variables; secrets are scrubbed from all tool output.
