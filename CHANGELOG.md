# Changelog

## Unreleased

### Added

- MCP server over stdio, runnable with `npx -y @apinator/mcp` (Node 18+).
- Tools: `publish_event`, `list_channels`, `get_channel`, `sign_channel_auth`, `watch_channel`.
- `APINATOR_READ_ONLY=1` mode that removes `publish_event`.
- Resources: the Apinator docs index (`llms.txt`) and a protocol / channel-type reference.
- `add-realtime-feature` prompt.
- Startup validation of `APINATOR_*` environment variables; secrets are scrubbed from all tool output.
