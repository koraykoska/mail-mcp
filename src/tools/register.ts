import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isMailError, mapTransportError, type MailError } from '../errors.js';
import { redactText } from '../redact.js';
import { anyAccountAllows } from '../safety.js';
import type { MailService } from '../service/mail-service.js';
import { TOOLS, type ToolDefinition } from './catalog.js';
import { renderToolText } from './render.js';

export function toolsForService(service: MailService): ToolDefinition[] {
  const accounts = Object.values(service.config.accounts);
  return TOOLS.filter((tool) => tool.kind === 'read' || anyAccountAllows(accounts, tool.kind));
}

export function registerTools(server: McpServer, service: MailService): ToolDefinition[] {
  const tools = toolsForService(service);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: {
          title: tool.title,
          ...tool.annotations,
        },
      },
      async (args) => {
        try {
          const data = await tool.run((args ?? {}) as Record<string, unknown>, service);
          return {
            content: [{ type: 'text', text: renderToolText(data) }],
            structuredContent: data,
          };
        } catch (error) {
          const mapped = isMailError(error) ? error : mapTransportError(error);
          return errorResult(mapped, service.config.secrets);
        }
      },
    );
  }
  return tools;
}

export function errorResult(
  error: MailError,
  secrets: readonly string[] = [],
): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const message = redactText(error.message, secrets);
  const hint = error.hint ? redactText(error.hint, secrets) : undefined;
  const text = hint ? `${error.code}: ${message}\nHint: ${hint}` : `${error.code}: ${message}`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      ok: false,
      error: { code: error.code, message, hint: hint ?? null },
    },
  };
}
