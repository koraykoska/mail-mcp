import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailService } from './service/mail-service.js';
import { SERVER_NAME, VERSION } from './version.js';
import { registerPrompts } from './mcp/prompts.js';
import { registerResources } from './mcp/resources.js';
import { registerTools } from './tools/register.js';

/**
 * Build an MCP server bound to a mail service.
 * Connections are opened lazily on the first tool call that needs them.
 */
export function createMcpServer(service: MailService): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: VERSION,
      title: 'Mail',
      websiteUrl: 'https://github.com/koraykoska/mail-mcp',
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        prompts: {},
        logging: {},
      },
    },
  );
  registerTools(server, service);
  registerResources(server, service);
  registerPrompts(server);
  return server;
}
