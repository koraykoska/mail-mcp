import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './log.js';
import type { MailService } from './service/mail-service.js';
import { createMcpServer } from './server.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

/**
 * Optional streamable HTTP transport. Stdio remains the default.
 * Each MCP session gets its own server object and shares the mail service.
 */
export async function startHttpServer(options: {
  service: MailService;
  logger: Logger;
  port: number;
  host: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, Session>();
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ name: 'mail-mcp', transport: 'streamable-http' }));
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404).end('Not found');
        return;
      }
      const sessionId = header(req.headers['mcp-session-id']);
      if (sessionId && sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing) {
          await existing.transport.handleRequest(req, res);
        }
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end('Method not allowed');
        return;
      }
      const body = await readJson(req);
      if (!isInitializeRequest(body)) {
        res.writeHead(400).end('Expected an initialize request');
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, close: async () => server.close() });
        },
      });
      const server = createMcpServer(options.service);
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) {
          sessions.delete(id);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      options.logger.error('http request failed', {
        message: error instanceof Error ? error.message : 'request failed',
      });
      if (!res.headersSent) {
        res.writeHead(500).end('Request failed');
      }
    }
  });
  await listen(http, options.port, options.host);
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}/mcp`,
    async close() {
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
