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
  /** BAD any UID SORT whose arguments include this substring. */
  badSortIncluding?: string;
  refuseStore?: boolean;
  /** Answer UID SORT RETURN with an ESEARCH untagged line. */
  esearchSort?: boolean;
  /** Answer UNCHANGEDSINCE STORE with a MODIFIED response code. */
  modifiedStore?: boolean;
  refuseCopy?: boolean;
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
  private readonly copies = new Map<string, ScriptedMessage[]>();
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

  /** Messages currently in INBOX or a mailbox created by COPY. */
  messagesIn(path: string): ScriptedMessage[] {
    if (path.toUpperCase() === 'INBOX') {
      return this.messages.map((message) => ({ ...message, flags: [...message.flags] }));
    }
    return (this.copies.get(path) ?? []).map((message) => ({
      ...message,
      flags: [...message.flags],
    }));
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
    if (command === 'AUTHENTICATE') {
      no('[AUTHENTICATIONFAILED] authentication failed');
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
      ctx.write('* QUOTA "" (STORAGE 10 100 MESSAGE 1 50)\r\n');
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
      const wanted = args.toUpperCase();
      const section = /BODY(?:\.PEEK)?\[([^\]]*)\]/i.exec(args);
      const sectionId = section?.[1] ?? '';
      const sourceWanted = sectionId === '' && Boolean(section);
      const headerWanted = sectionId.toUpperCase().includes('HEADER');
      const partWanted = Boolean(section) && !sourceWanted && !headerWanted;
      const uidFilter = /^\d+$/.test(argParts[1] ?? '') ? Number(argParts[1]) : undefined;
      let sequence = 0;
      for (const message of this.messages) {
        sequence += 1;
        if (uidFilter !== undefined && message.uid !== uidFilter) {
          continue;
        }
        const source = Buffer.from(message.raw);
        const flags = message.flags.join(' ');
        const common = `UID ${message.uid} FLAGS (${flags}) RFC822.SIZE ${source.length} INTERNALDATE "01-Jan-2026 00:00:00 +0000"`;
        if (sourceWanted) {
          const partial = /<(\d+)\.(\d+)>/.exec(args);
          let payload = source;
          if (partial?.[1] && partial[2]) {
            const start = Number(partial[1]);
            const count = Number(partial[2]);
            payload = source.subarray(start, start + count);
          }
          ctx.write(`* ${sequence} FETCH (${common} BODY[] {${payload.length}}\r\n`);
          socket.write(payload);
          socket.write(')\r\n');
          continue;
        }
        if (partWanted) {
          const body = message.raw.includes('\r\n\r\n')
            ? message.raw.slice(message.raw.indexOf('\r\n\r\n') + 4)
            : message.raw;
          const payload = Buffer.from(body);
          ctx.write(`* ${sequence} FETCH (${common} BODY[${sectionId}] {${payload.length}}\r\n`);
          socket.write(payload);
          socket.write(')\r\n');
          continue;
        }
        if (headerWanted) {
          const split = message.raw.indexOf('\r\n\r\n');
          const headers = Buffer.from(split >= 0 ? message.raw.slice(0, split + 4) : message.raw);
          ctx.write(`* ${sequence} FETCH (${common} BODY[HEADER] {${headers.length}}\r\n`);
          socket.write(headers);
          socket.write(')\r\n');
          continue;
        }
        if (wanted.includes('PREVIEW')) {
          ctx.write(`* ${sequence} FETCH (UID ${message.uid} PREVIEW "preview text")\r\n`);
          continue;
        }
        ctx.write(
          `* ${sequence} FETCH (${common} ${envelopeOf(message.raw)} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${source.length} 1))\r\n`,
        );
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
      if (
        this.options.badSortIncluding &&
        args.toUpperCase().includes(this.options.badSortIncluding.toUpperCase())
      ) {
        bad('Unknown sort argument');
        return;
      }
      const uids = this.messages.map((message) => message.uid).join(',');
      if (this.options.esearchSort && args.toUpperCase().includes('RETURN')) {
        ctx.write(
          `* ESEARCH (TAG "${tag}") UID COUNT ${this.messages.length} ALL ${uids || '1'}\r\n`,
        );
        ok('SORT completed');
        return;
      }
      ctx.write(`* SORT ${uids.replaceAll(',', ' ')}\r\n`);
      ok('SORT completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('STORE')) {
      if (this.options.refuseStore) {
        no('STORE failed');
        return;
      }
      if (this.options.modifiedStore && args.toUpperCase().includes('UNCHANGEDSINCE')) {
        ok('[MODIFIED 1] STORE completed');
        return;
      }
      const uid = Number(argParts[1]);
      const message = this.messages.find((item) => item.uid === uid);
      if (message) {
        const flags = flagsIn(args);
        const upper = args.toUpperCase();
        if (upper.includes('-FLAGS')) {
          message.flags = message.flags.filter((flag) => !flags.includes(flag));
        } else if (upper.includes('+FLAGS')) {
          for (const flag of flags) {
            if (!message.flags.includes(flag)) {
              message.flags.push(flag);
            }
          }
        } else if (flags.length > 0) {
          message.flags = flags;
        }
      }
      ok('STORE completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().includes('COPY')) {
      if (this.options.refuseCopy) {
        no('COPY failed');
        return;
      }
      const uid = Number(argParts[1]);
      const destination = unquote(argParts[argParts.length - 1] ?? '');
      const source = this.messages.find((item) => item.uid === uid);
      if (!source || !destination) {
        no('COPY failed');
        return;
      }
      const copied = this.copies.get(destination) ?? [];
      const newUid = this.nextUid;
      this.nextUid += 1;
      copied.push({ uid: newUid, raw: source.raw, flags: [...source.flags] });
      this.copies.set(destination, copied);
      ok(`[COPYUID ${this.uidValidity} ${uid} ${newUid}] COPY completed`);
      return;
    }
    if (command === 'UID' && args.toUpperCase().includes('MOVE')) {
      if (!ctx.capabilities.includes('MOVE')) {
        bad('MOVE not supported');
        return;
      }
      ok('MOVE completed');
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
      const poke = setTimeout(() => {
        ctx.write('* 1 EXISTS\r\n');
      }, 40);
      const onData = (chunk: Buffer): void => {
        if (chunk.toString('utf8').toUpperCase().includes('DONE')) {
          clearTimeout(poke);
          socket.off('data', onData);
          ok('IDLE completed');
        }
      };
      socket.on('data', onData);
      return;
    }
    if (command === 'EXPUNGE') {
      this.messages = this.messages.filter((message) => !message.flags.includes('\\Deleted'));
      ok('EXPUNGE completed');
      return;
    }
    if (
      command === 'CREATE' ||
      command === 'DELETE' ||
      command === 'RENAME' ||
      command === 'SUBSCRIBE' ||
      command === 'UNSUBSCRIBE' ||
      command === 'CLOSE'
    ) {
      ok(`${command} completed`);
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('EXPUNGE')) {
      const uid = Number(argParts[1]);
      this.messages = this.messages.filter((message) => message.uid !== uid);
      ok('EXPUNGE completed');
      return;
    }
    bad(`Unsupported ${command}`);
  }
}

function envelopeOf(raw: string): string {
  const subject = headerOf(raw, 'subject') ?? 'message';
  const from = headerOf(raw, 'from') ?? 'ada@example.com';
  const address = /([^\s<>]+@[^\s<>]+)/.exec(from)?.[1] ?? 'ada@example.com';
  const [local, domain] = address.split('@');
  const messageId = headerOf(raw, 'message-id') ?? '<m@example.com>';
  const date = '01-Jan-2026 00:00:00 +0000';
  return `ENVELOPE ("${date}" "${imapQuote(subject)}" (("Ada" NIL "${imapQuote(local ?? 'ada')}" "${imapQuote(domain ?? 'example.com')}")) NIL NIL NIL NIL NIL NIL "${imapQuote(messageId)}")`;
}

function headerOf(raw: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(raw);
  return match?.[1]?.trim();
}

function imapQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function flagsIn(args: string): string[] {
  const match = /\(([^)]*)\)/.exec(args);
  if (!match?.[1]) {
    return [];
  }
  return match[1].split(/\s+/).filter(Boolean);
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
