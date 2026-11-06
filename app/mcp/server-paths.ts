import path from "node:path";

const directory = process.env.NEXTCHAT_MCP_CONFIG_DIR;
if (directory && !path.isAbsolute(directory)) {
  throw new Error("NEXTCHAT_MCP_CONFIG_DIR must be an absolute path");
}
export const MCP_CONFIG_DIRECTORY =
  directory ?? path.join(process.cwd(), "app/mcp");
export const MCP_CONFIG_PATH = path.join(
  MCP_CONFIG_DIRECTORY,
  "mcp_config.json",
);
export const MCP_OAUTH_PATH = path.join(MCP_CONFIG_DIRECTORY, "mcp_oauth.json");
