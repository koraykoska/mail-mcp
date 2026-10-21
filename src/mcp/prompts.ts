import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'summarise_inbox',
    {
      title: 'Summarise the inbox',
      description:
        'Instructions for summarising recent inbox mail. The caller should then use mail_list_messages rather than inventing messages.',
      argsSchema: {
        account: z.string().optional().describe('Account id. Omit for the default account.'),
        limit: z.string().optional().describe('How many messages to read. Default 20.'),
      },
    },
    async (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Summarise the inbox for the user.',
              `Account: ${args.account ?? 'the default account'}.`,
              `Read at most ${args.limit ?? '20'} messages with mail_list_messages (mailbox INBOX, includeSnippet true).`,
              'Group by what needs a reply, what is informational, and what looks like noise.',
              'Quote subjects and senders from the tool result. Do not invent messages that were not returned.',
              'If the call fails, report the error code and hint.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'draft_reply',
    {
      title: 'Draft a reply',
      description:
        'Instructions for drafting a reply to one UID. The caller should fetch the message, save it with mail_create_reply_draft, and send it with mail_reply_message or mail_send_draft only after confirmation.',
      argsSchema: {
        account: z.string().optional().describe('Account id.'),
        mailbox: z.string().describe('Mailbox path. Usually INBOX.'),
        uid: z.string().describe('Message UID as a decimal string.'),
        instruction: z.string().optional().describe('Tone or points the reply must cover.'),
      },
    },
    async (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Draft a reply to UID ${args.uid} in mailbox ${args.mailbox} (account ${args.account ?? 'default'}).`,
              'First call mail_get_message and base the reply only on that content.',
              args.instruction
                ? `Instruction from the user: ${args.instruction}`
                : 'Keep the reply short and specific.',
              'Save it with mail_create_reply_draft (same mailbox and uid) so In-Reply-To, References, and the quoted body are stored in Drafts without sending.',
              'Show that draft and wait for confirmation before calling mail_reply_message or mail_send_draft.',
              'mail_reply_message sends immediately. mail_send_draft sends the saved draft and keeps its threading headers.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
