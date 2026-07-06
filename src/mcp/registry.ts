/**
 * MCP Marketplace (Phase 3): a curated registry of well-known MCP servers.
 * `devpilot mcp install <id>` writes the server into the config of every
 * supported AI tool detected on the machine.
 */

export interface McpServerSpec {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  /** Environment variables the server needs (user fills in values). */
  env?: string[];
}

export const MCP_REGISTRY: McpServerSpec[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repository, issue and PR access via the GitHub API',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write access to allowed directories',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent knowledge-graph memory across sessions',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch and convert web pages for LLM use',
    command: 'npx',
    args: ['-y', '@mokei/mcp-fetch'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query Postgres databases (read-only)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: ['POSTGRES_CONNECTION_STRING'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation and web scraping',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and send Slack messages',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    id: 'firebase',
    name: 'Firebase',
    description: 'Firebase project management and data access',
    command: 'npx',
    args: ['-y', 'firebase-tools@latest', 'experimental:mcp'],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Inspect Sentry errors and issues',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    env: ['SENTRY_AUTH_TOKEN'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation via Playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
];

export function searchMcp(query: string): McpServerSpec[] {
  const q = query.toLowerCase();
  return MCP_REGISTRY.filter(
    (s) =>
      s.id.includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  );
}

export function getMcp(id: string): McpServerSpec | undefined {
  return MCP_REGISTRY.find((s) => s.id === id);
}
