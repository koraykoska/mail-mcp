import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailService } from '../service/mail-service.js';

/**
 * Expose accounts and individual messages as resources.
 * Message URIs are mail://{account}/{mailbox}/{uid} with mailbox and account percent-encoded
 * because mailbox paths may contain slashes.
 */
export function registerResources(server: McpServer, service: MailService): void {
  server.registerResource(
    'accounts',
    'mail://accounts',
    {
      title: 'Mail accounts',
      description: 'Configured accounts without secrets. Same data as mail_list_accounts.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ accounts: service.listAccounts() }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'message',
    new ResourceTemplate('mail://{account}/{mailbox}/{uid}', {
      list: undefined,
    }),
    {
      title: 'Mail message',
      description:
        'One message. account, mailbox, and uid are path segments. Percent-encode mailbox names that contain slashes. Example: mail://work/INBOX/41',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const account = decodeURIComponent(String(variables.account ?? ''));
      const mailbox = decodeURIComponent(String(variables.mailbox ?? ''));
      const uid = Number(variables.uid);
      const data = await service.getMessage({ account, mailbox, uid });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );
}
