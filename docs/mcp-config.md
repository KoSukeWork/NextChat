# MCP configuration directory

MCP uses `app/mcp/mcp_config.json` on the web server and the application's
native configuration directory in the desktop app. To isolate profiles or
place the web configuration on persistent storage, set
`NEXTCHAT_MCP_CONFIG_DIR` to an absolute directory before starting NextChat.
The file name inside that directory is `mcp_config.json`.

Use a directory you trust: active local MCP servers in its configuration can
run programs with your account's permissions. Desktop edits and imports still
require the native approval dialog. Backup files contain credentials, including
remote MCP headers, and should be kept private. MCP configuration remains
outside cloud sync.
