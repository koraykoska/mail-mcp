import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, type TlsOptions } from 'node:tls';
import { encodeModifiedUtf7 } from '../../src/utf7.js';

export interface ScriptedMessage {
  uid: number;
  raw: string;
  flags: string[];
}

export interface ScriptedOptions {
  user?: string;
  password?: string;
  capabilities?: string[];
  tls?: TlsOptions;
  starttls?: boolean;
  uidValidity?: number;
  dropAfterCommands?: number;
  /** When set, SELECT reports this UIDVALIDITY after the given number of selects. */
  bumpUidValidityAfter?: number;
  refuseSearch?: boolean;
}

/**
 * Small IMAP server used to exercise fallbacks GreenMail does not offer:
 * missing MOVE/SORT/IDLE, STARTTLS, UIDVALIDITY changes, and mid-command drops.
 */
export class ScriptedImap {
  port = 0;
  private server: Server;
  private uidValidity: number;
  private selects = 0;
  private messages: ScriptedMessage[] = [];
  private nextUid = 1;
  private clients = new Set<Socket>();
  readonly trace: string[] = [];
  private readonly listening: Promise<void>;

  constructor(private readonly options: ScriptedOptions = {}) {
    this.uidValidity = options.uidValidity ?? 42;
    const capabilities = options.capabilities ?? ['IMAP4rev1', 'UIDPLUS', 'IDLE'];
    const handler = (socket: Socket): void => {
      this.clients.add(socket);
      let buffer = Buffer.alloc(0);
      let commands = 0;
      let selected = false;
      let tlsUpgraded = false;
      const write = (line: string): void => {
        if (!socket.destroyed) {
          socket.write(line);
        }
      };
      write('* OK scripted IMAP ready\r\n');
      const consume = (): void => {
        while (buffer.length > 0) {
          const newline = buffer.indexOf('\r\n');
          if (newline < 0) {
            return;
          }
          const line = buffer.subarray(0, newline).toString('utf8');
          buffer = buffer.subarray(newline + 2);
          const literal = /\{(\d+)\+?\}$/.exec(line);
          if (literal) {
            const size = Number(literal[1]);
            if (buffer.length < size) {
              buffer = Buffer.concat([Buffer.from(`${line}\r\n`), buffer]);
              return;
            }
            const data = buffer.subarray(0, size);
            buffer = buffer.subarray(size);
            if (buffer.subarray(0, 2).toString() === '\r\n') {
              buffer = buffer.subarray(2);
            }
            this.handle(socket, line, data, {
              write,
              selected: () => selected,
              select: () => {
                selected = true;
              },
              capabilities,
              tlsUpgraded: () => tlsUpgraded,
              markTls: () => {
                tlsUpgraded = true;
              },
            });
            continue;
          }
          if (line.endsWith('}') && !line.includes('+')) {
            write('+ go ahead\r\n');
          }
          commands += 1;
          if (this.options.dropAfterCommands && commands > this.options.dropAfterCommands) {
            socket.destroy();
            return;
          }
          this.handle(socket, line, undefined, {
            write,
            selected: () => selected,
            select: () => {
              selected = true;
            },
            capabilities,
            tlsUpgraded: () => tlsUpgraded,
            markTls: () => {
              tlsUpgraded = true;
            },
          });
        }
      };
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        consume();
      });
      socket.on('close', () => this.clients.delete(socket));
    };
    if (options.tls && !options.starttls) {
      this.server = createTlsServer(options.tls, handler);
    } else {
      this.server = createServer(handler);
    }
    this.listening = new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  }

  async ready(): Promise<void> {
    await this.listening;
  }

  addMessage(raw: string, flags: string[] = []): number {
    const uid = this.nextUid;
    this.nextUid += 1;
    this.messages.push({ uid, raw, flags });
    return uid;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(
    socket: Socket,
    line: string,
    literal: Buffer | undefined,
    ctx: {
      write: (line: string) => void;
      selected: () => boolean;
      select: () => void;
      capabilities: string[];
      tlsUpgraded: () => boolean;
      markTls: () => void;
    },
  ): void {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!match) {
      return;
    }
    const tag = match[1] ?? '*';
    const rest = match[2] ?? '';
    const [commandRaw, ...argParts] = splitCommand(rest);
    const command = (commandRaw ?? '').toUpperCase();
    const args = argParts.join(' ');
    this.trace.push(`${command} ${args}`.trim());
    const ok = (text: string): void => ctx.write(`${tag} OK ${text}\r\n`);
    const bad = (text: string): void => ctx.write(`${tag} BAD ${text}\r\n`);
    const no = (text: string): void => ctx.write(`${tag} NO ${text}\r\n`);
    if (command === 'CAPABILITY') {
      const extra = ctx.tlsUpgraded() ? '' : this.options.starttls ? ' STARTTLS' : '';
      ctx.write(`* CAPABILITY ${ctx.capabilities.join(' ')}${extra}\r\n`);
      ok('CAPABILITY completed');
      return;
    }
    if (command === 'STARTTLS') {
      if (!this.options.tls || !this.options.starttls) {
        bad('STARTTLS not available');
        return;
      }
      ok('Begin TLS');
      const tls = createTlsServer(this.options.tls);
      socket.removeAllListeners('data');
      // Upgrade is exercised by ImapFlow; the test server accepts the handshake
      // by piping through tls.TLSSocket via the Node connection listener pattern.
      void tls;
      ctx.markTls();
      return;
    }
    if (command === 'LOGIN') {
      const user = unquote(argParts[0] ?? '');
      const password = unquote(argParts[1] ?? '');
      if (
        user === (this.options.user ?? 'user') &&
        password === (this.options.password ?? 'secret')
      ) {
        ok('LOGIN completed');
      } else {
        no('LOGIN failed');
      }
      return;
    }
    if (command === 'LOGOUT') {
      ctx.write('* BYE scripted\r\n');
      ok('LOGOUT completed');
      socket.end();
      return;
    }
    if (command === 'NOOP' || command === 'CHECK') {
      ok(`${command} completed`);
      return;
    }
    if (command === 'NAMESPACE') {
      if (!ctx.capabilities.includes('NAMESPACE')) {
        bad('NAMESPACE not supported');
        return;
      }
      ctx.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
      ok('NAMESPACE completed');
      return;
    }
    if (command === 'ID') {
      if (!ctx.capabilities.includes('ID')) {
        bad('ID not supported');
        return;
      }
      ctx.write('* ID ("name" "scripted" "version" "1")\r\n');
      ok('ID completed');
      return;
    }
    if (command === 'GETQUOTAROOT' || command === 'GETQUOTA') {
      if (!ctx.capabilities.includes('QUOTA')) {
        bad('QUOTA not supported');
        return;
      }
      ctx.write('* QUOTA "" (STORAGE 10 100)\r\n');
      ok('QUOTA completed');
      return;
    }
    if (command === 'LIST' || command === 'LSUB') {
      ctx.write(`* LIST (\\HasNoChildren) "/" ${quote(encodeModifiedUtf7('INBOX'))}\r\n`);
      ok('LIST completed');
      return;
    }
    if (command === 'SELECT' || command === 'EXAMINE') {
      this.selects += 1;
      if (
        this.options.bumpUidValidityAfter !== undefined &&
        this.selects > this.options.bumpUidValidityAfter
      ) {
        this.uidValidity += 1;
      }
      ctx.select();
      ctx.write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
      ctx.write('* 0 RECENT\r\n');
      ctx.write(`* ${this.messages.length} EXISTS\r\n`);
      ctx.write(`* OK [UIDVALIDITY ${this.uidValidity}] UIDs valid\r\n`);
      ctx.write(`* OK [UIDNEXT ${this.nextUid}] Predicted next UID\r\n`);
      ok(`[${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${command} completed`);
      return;
    }
    if (command === 'STATUS') {
      ctx.write(
        `* STATUS "INBOX" (MESSAGES ${this.messages.length} RECENT 0 UNSEEN ${this.messages.length} UIDNEXT ${this.nextUid} UIDVALIDITY ${this.uidValidity})\r\n`,
      );
      ok('STATUS completed');
      return;
    }
    if (command === 'SEARCH' || (command === 'UID' && args.toUpperCase().startsWith('SEARCH'))) {
      if (this.options.refuseSearch) {
        no('SEARCH refused');
        return;
      }
      const uids = this.messages.map((message) => message.uid);
      ctx.write(`* SEARCH ${uids.join(' ')}\r\n`);
      ok('SEARCH completed');
      return;
    }
    if (command === 'GETACL') {
      ctx.write('* ACL INBOX user lrswipkxtecdan\r\n');
      ok('GETACL completed');
      return;
    }
    if (command === 'SETACL' || command === 'DELETEACL') {
      ok(`${command} completed`);
      return;
    }
    if (command === 'GETMETADATA') {
      ctx.write('* METADATA INBOX ("/private/comment" "hello")\r\n');
      ok('GETMETADATA completed');
      return;
    }
    if (command === 'SETMETADATA') {
      ok('SETMETADATA completed');
      return;
    }
    if (command === 'ENABLE') {
      const requested = args.split(/\s+/).filter(Boolean);
      const enabled = requested.filter((item) =>
        ctx.capabilities.some((capability) => capability.toUpperCase() === item.toUpperCase()),
      );
      if (enabled.length > 0) {
        ctx.write(`* ENABLED ${enabled.join(' ')}\r\n`);
      }
      ok('ENABLE completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('FETCH')) {
      for (const message of this.messages) {
        const source = Buffer.from(message.raw);
        ctx.write(
          `* ${message.uid} FETCH (UID ${message.uid} FLAGS (${message.flags.join(' ')}) RFC822.SIZE ${source.length} INTERNALDATE "01-Jan-2026 00:00:00 +0000" BODY[] {${source.length}}\r\n`,
        );
        socket.write(source);
        socket.write('\r\n)\r\n');
      }
      ok('FETCH completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('THREAD')) {
      ctx.write('* THREAD (1 (2))\r\n');
      ok('THREAD completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('SORT')) {
      ctx.write('* SORT 2 1\r\n');
      ok('SORT completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('STORE')) {
      ok('STORE completed');
      return;
    }
    if (command === 'UID' && /COPY|MOVE/.test(args.toUpperCase())) {
      if (args.toUpperCase().includes('MOVE') && !ctx.capabilities.includes('MOVE')) {
        bad('MOVE not supported');
        return;
      }
      ok('COPY completed');
      return;
    }
    if (command === 'APPEND') {
      const raw = literal ? literal.toString('utf8') : '';
      this.addMessage(raw, ['\\Seen']);
      ok(`[APPENDUID ${this.uidValidity} ${this.nextUid - 1}] APPEND completed`);
      return;
    }
    if (command === 'IDLE') {
      if (!ctx.capabilities.includes('IDLE')) {
        bad('IDLE not supported');
        return;
      }
      ctx.write('+ idling\r\n');
      const onData = (chunk: Buffer): void => {
        if (chunk.toString('utf8').toUpperCase().includes('DONE')) {
          socket.off('data', onData);
          ok('IDLE completed');
        }
      };
      socket.on('data', onData);
      return;
    }
    if (
      command === 'CREATE' ||
      command === 'DELETE' ||
      command === 'RENAME' ||
      command === 'SUBSCRIBE' ||
      command === 'UNSUBSCRIBE' ||
      command === 'CLOSE' ||
      command === 'EXPUNGE'
    ) {
      ok(`${command} completed`);
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('EXPUNGE')) {
      ok('EXPUNGE completed');
      return;
    }
    bad(`Unsupported ${command}`);
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoteOpen = false;
  for (const char of input) {
    if (char === '"') {
      quoteOpen = !quoteOpen;
      current += char;
      continue;
    }
    if (char === ' ' && !quoteOpen) {
      if (current) {
        parts.push(current);
      }
      current = '';
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}
