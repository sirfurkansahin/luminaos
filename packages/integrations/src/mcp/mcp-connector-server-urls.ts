export const MCP_CONNECTOR_SERVER_URLS: Record<
  'notion' | 'google-drive' | 'gmail' | 'slack' | 'github',
  string
> = {
  notion: 'https://mcp.notion.com',
  'google-drive': 'https://drivemcp.googleapis.com/mcp/v1',
  gmail: 'https://gmailmcp.googleapis.com/mcp/v1',
  slack: 'https://mcp.slack.com/mcp',
  github: 'https://api.githubcopilot.com/mcp/',
};
