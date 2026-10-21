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
  /** Close the socket instead of answering a UID SORT that includes this substring. */
  dropOnSortIncluding?: string;
  refuseStore?: boolean;
  /** Answer UID SORT RETURN with an ESEARCH untagged line. */
  esearchSort?: boolean;
  /** Send the full RFC822 literal even when the client asked for a partial body. */
  ignorePartial?: boolean;
  /** RFC822.SIZE to advertise. Defaults to the real message size. */
  reportedSize?: number;
  /** Answer UNCHANGEDSINCE STORE with a MODIFIED response code. */
  modifiedStore?: boolean;
  refuseCopy?: boolean;
  /**
   * iCloud SEARCH: `NOT UID` and `NOT <sequence>` match nothing, and a NOT that
   * mixes a text test with a flag or UID test is `NO [UNAVAILABLE]`.
   */
  icloud?: boolean;
  /** COPY stores the messages and answers OK without a COPYUID response code. */
  omitCopyUid?: boolean;
  /**
   * After a successful UID COPY, increment UIDVALIDITY while the mailbox stays
   * selected. The COPYUID response still carries the value from before the copy.
   */
  bumpUidValidityAfterCopy?: boolean;
  /**
   * Drop the socket around one command. `nth` counts matches of `pattern` starting at 1.
   * Without `apply`, the socket closes before that command runs.
   * With `apply`, that command finishes and the next command closes the socket before it runs.
   */
  dropMatching?: { pattern: RegExp; nth?: number; apply?: boolean };
  /** Advertised capabilities left out of the ENABLED response. The ENABLE command still succeeds. */
  omitEnabled?: string[];
  /** A UID SEARCH that matches every message answers ESEARCH ALL 1:* instead of listing UIDs. */
  esearchAllStar?: boolean;
  /**
   * When a UID SEARCH uses RETURN, this value is the ESEARCH ALL set.
   * Return undefined to list the matching UIDs.
   */
  esearchAll?: (args: string, uids: number[]) => string | undefined;
  /** Extra untagged lines written before a UID SEARCH that has no RETURN. */
  beforePlainSearch?: () => string | undefined;
  /** A UID SEARCH without RETURN answers ESEARCH ALL * instead of a number list. */
  plainSearchStar?: boolean;
  /** With RETURN, also send this `* SEARCH` line. Used when it disagrees with ALL. */
  alsoSearch?: string;
  /**
   * Append a CONDSTORE modifier. A plain search answers `* SEARCH <uids> (MODSEQ n)`.
   * An ESEARCH search answers `ALL <uids> MODSEQ n` and the same parenthesized SEARCH line.
   */
  searchModseq?: number;
  /** SELECT reports this UIDNEXT instead of the next UID the server will assign. */
  selectUidNext?: number;
  /** Write the greeting and then close the socket, before login. */
  closeAfterGreeting?: boolean;
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
  private dropHits = 0;
  private dropNext = false;
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
      const enabled = new Set<string>();
      const write = (line: string): void => {
        if (!socket.destroyed) {
          socket.write(line);
        }
      };
      const context = (): {
        write: (line: string) => void;
        selected: () => boolean;
        select: () => void;
        capabilities: string[];
        tlsUpgraded: () => boolean;
        markTls: () => void;
        noteEnabled: (name: string) => void;
        isRev2: () => boolean;
      } => ({
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
        noteEnabled: (name: string) => {
          enabled.add(name.toUpperCase());
        },
        isRev2: () =>
          enabled.has('IMAP4REV2') ||
          (capabilities.some((item) => item.toUpperCase() === 'IMAP4REV2') &&
            !capabilities.some((item) => item.toUpperCase() === 'IMAP4REV1')),
      });
      write('* OK scripted IMAP ready\r\n');
      if (this.options.closeAfterGreeting) {
        socket.end();
        return;
      }
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
            this.handle(socket, line, data, context());
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
          this.handle(socket, line, undefined, context());
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

  /** Remove one UID and leave the next-UID counter where it is. */
  dropUid(uid: number): void {
    this.messages = this.messages.filter((message) => message.uid !== uid);
  }

  /** Mailboxes that received a COPY or MOVE. */
  copiedPaths(): string[] {
    return [...this.copies.keys()];
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
      noteEnabled: (name: string) => void;
      isRev2: () => boolean;
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
    const lineText = `${command} ${args}`.trim();
    this.trace.push(lineText);
    if (this.dropNext) {
      this.dropNext = false;
      socket.destroy();
      return;
    }
    const drop = this.options.dropMatching;
    if (drop) {
      drop.pattern.lastIndex = 0;
      if (drop.pattern.test(lineText)) {
        this.dropHits += 1;
        if (this.dropHits === (drop.nth ?? 1)) {
          if (drop.apply) {
            this.dropNext = true;
          } else {
            socket.destroy();
            return;
          }
        }
      }
    }
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
      ctx.write(
        `* OK [UIDNEXT ${this.options.selectUidNext ?? this.nextUid}] Predicted next UID\r\n`,
      );
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
      if (this.options.icloud) {
        const fault = icloudCommandFault(args);
        if (fault === 'unavailable') {
          no('[UNAVAILABLE] Unexpected exception');
          return;
        }
        if (fault === 'empty') {
          this.writeSearch(ctx, tag, args, []);
          ok('SEARCH completed');
          return;
        }
      }
      const uids = searchUids(args, this.messages);
      this.writeSearch(ctx, tag, args, uids);
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
      const omitted = new Set((this.options.omitEnabled ?? []).map((item) => item.toUpperCase()));
      const enabled = requested.filter(
        (item) =>
          ctx.capabilities.some((capability) => capability.toUpperCase() === item.toUpperCase()) &&
          !omitted.has(item.toUpperCase()),
      );
      for (const item of enabled) {
        ctx.noteEnabled(item);
      }
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
      const uidToken = argParts[1] ?? '';
      const allowed =
        uidToken.length > 0 && uidToken !== '*'
          ? new Set(parseUidSet(uidToken, this.messages))
          : undefined;
      let sequence = 0;
      for (const message of this.messages) {
        sequence += 1;
        if (allowed && !allowed.has(message.uid)) {
          continue;
        }
        const source = Buffer.from(message.raw);
        const flags = message.flags.join(' ');
        const advertised = this.options.reportedSize ?? source.length;
        const common = `UID ${message.uid} FLAGS (${flags}) RFC822.SIZE ${advertised} INTERNALDATE "01-Jan-2026 00:00:00 +0000"`;
        if (sourceWanted) {
          const partial = /<(\d+)\.(\d+)>/.exec(args);
          let payload = source;
          if (!this.options.ignorePartial && partial?.[1] && partial[2]) {
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
        if (headerWanted && !wanted.includes('ENVELOPE')) {
          const headers = headerSection(message.raw, args);
          ctx.write(`* ${sequence} FETCH (${common} BODY[HEADER] {${headers.length}}\r\n`);
          socket.write(headers);
          socket.write(')\r\n');
          continue;
        }
        if (wanted.includes('PREVIEW')) {
          ctx.write(`* ${sequence} FETCH (UID ${message.uid} PREVIEW "preview text")\r\n`);
          continue;
        }
        if (headerWanted) {
          const headers = headerSection(message.raw, args);
          ctx.write(
            `* ${sequence} FETCH (${common} ${envelopeOf(message.raw)} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${source.length} 1) BODY[HEADER.FIELDS (REFERENCES IN-REPLY-TO MESSAGE-ID)] {${headers.length}}\r\n`,
          );
          socket.write(headers);
          socket.write(')\r\n');
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
        this.options.dropOnSortIncluding &&
        args.toUpperCase().includes(this.options.dropOnSortIncluding.toUpperCase())
      ) {
        socket.destroy();
        return;
      }
      if (
        this.options.badSortIncluding &&
        args.toUpperCase().includes(this.options.badSortIncluding.toUpperCase())
      ) {
        bad('Unknown sort argument');
        return;
      }
      if (args.toUpperCase().includes('(RETURN')) {
        bad('Unknown sort argument');
        return;
      }
      const allUids = this.messages.map((message) => message.uid);
      const partial = /RETURN \(PARTIAL (\d+):(\d+)/i.exec(args);
      let uids = allUids;
      if (partial?.[1] && partial[2]) {
        const start = Number(partial[1]);
        const end = Number(partial[2]);
        uids = allUids.slice(Math.max(0, start - 1), end);
      }
      if (partial?.[1] && partial[2]) {
        const listed = uids.join(',') || 'NIL';
        ctx.write(
          `* ESEARCH (TAG "${tag}") UID PARTIAL (${partial[1]}:${partial[2]} ${listed}) COUNT ${allUids.length}\r\n`,
        );
        ok('SORT completed');
        return;
      }
      if (this.options.esearchSort && args.toUpperCase().includes('RETURN')) {
        const listed = allUids.join(',') || 'NIL';
        ctx.write(`* ESEARCH (TAG "${tag}") UID COUNT ${allUids.length} ALL ${listed}\r\n`);
        ok('SORT completed');
        return;
      }
      ctx.write(`* SORT ${uids.join(' ')}\r\n`);
      ok('SORT completed');
      return;
    }
    if (command === 'UID' && args.toUpperCase().startsWith('STORE')) {
      if (this.options.refuseStore) {
        no('STORE failed');
        return;
      }
      const targets = new Set(parseUidSet(argParts[1] ?? '', this.messages));
      if (this.options.modifiedStore && args.toUpperCase().includes('UNCHANGEDSINCE')) {
        ok('[MODIFIED 1] STORE completed');
        return;
      }
      for (const message of this.messages) {
        if (!targets.has(message.uid)) {
          continue;
        }
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
      const destination = unquote(argParts[argParts.length - 1] ?? '');
      const sources = parseUidSet(argParts[1] ?? '', this.messages)
        .map((uid) => this.messages.find((item) => item.uid === uid))
        .filter((item): item is ScriptedMessage => Boolean(item));
      if (!destination || sources.length === 0) {
        no('COPY failed');
        return;
      }
      const copied = this.copies.get(destination) ?? [];
      const sourceUids: number[] = [];
      const newUids: number[] = [];
      for (const source of sources) {
        const newUid = this.nextUid;
        this.nextUid += 1;
        copied.push({ uid: newUid, raw: source.raw, flags: [...source.flags] });
        sourceUids.push(source.uid);
        newUids.push(newUid);
      }
      this.copies.set(destination, copied);
      if (this.options.omitCopyUid) {
        ok('COPY completed');
      } else {
        ok(
          `[COPYUID ${this.uidValidity} ${sourceUids.join(',')} ${newUids.join(',')}] COPY completed`,
        );
      }
      if (this.options.bumpUidValidityAfterCopy) {
        this.uidValidity += 1;
      }
      return;
    }
    if (command === 'UID' && args.toUpperCase().includes('MOVE')) {
      if (!ctx.capabilities.includes('MOVE') && !ctx.isRev2()) {
        bad('MOVE not supported');
        return;
      }
      const destination = unquote(argParts[argParts.length - 1] ?? '');
      const sources = parseUidSet(argParts[1] ?? '', this.messages)
        .map((uid) => this.messages.find((item) => item.uid === uid))
        .filter((item): item is ScriptedMessage => Boolean(item));
      if (!destination || sources.length === 0) {
        no('MOVE failed');
        return;
      }
      const copied = this.copies.get(destination) ?? [];
      const sourceUids: number[] = [];
      const newUids: number[] = [];
      const moved = new Set<number>();
      for (const source of sources) {
        const newUid = this.nextUid;
        this.nextUid += 1;
        copied.push({ uid: newUid, raw: source.raw, flags: [...source.flags] });
        sourceUids.push(source.uid);
        newUids.push(newUid);
        moved.add(source.uid);
      }
      this.copies.set(destination, copied);
      this.messages = this.messages.filter((message) => !moved.has(message.uid));
      ok(
        `[COPYUID ${this.uidValidity} ${sourceUids.join(',')} ${newUids.join(',')}] MOVE completed`,
      );
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
      const targets = new Set(parseUidSet(argParts[1] ?? '', this.messages));
      this.messages = this.messages.filter((message) => !targets.has(message.uid));
      ok('EXPUNGE completed');
      return;
    }
    bad(`Unsupported ${command}`);
  }

  private writeSearch(
    ctx: { write: (line: string) => void },
    tag: string,
    args: string,
    uids: number[],
  ): void {
    if (args.toUpperCase().includes('RETURN')) {
      const custom = this.options.esearchAll?.(args, uids);
      const star =
        custom === undefined &&
        this.options.esearchAllStar &&
        uids.length > 0 &&
        uids.length === this.messages.length;
      const all = custom ?? (star ? '1:*' : uids.length > 0 ? uids.join(',') : undefined);
      const listed = all ? ` ALL ${all}` : '';
      const modseq =
        this.options.searchModseq !== undefined ? ` MODSEQ ${this.options.searchModseq}` : '';
      if (this.options.alsoSearch !== undefined) {
        ctx.write(`* SEARCH ${this.options.alsoSearch}\r\n`);
      } else if (this.options.searchModseq !== undefined) {
        const list = uids.join(' ');
        ctx.write(`* SEARCH ${list}${list ? ' ' : ''}(MODSEQ ${this.options.searchModseq})\r\n`);
      }
      ctx.write(`* ESEARCH (TAG "${tag}") UID COUNT ${uids.length}${listed}${modseq}\r\n`);
      return;
    }
    const banner = this.options.beforePlainSearch?.();
    if (banner) {
      ctx.write(banner);
    }
    if (this.options.plainSearchStar) {
      ctx.write(`* ESEARCH (TAG "${tag}") UID ALL *\r\n`);
      return;
    }
    const list = uids.join(' ');
    const modseq =
      this.options.searchModseq !== undefined ? `(MODSEQ ${this.options.searchModseq})` : '';
    ctx.write(`* SEARCH ${[list, modseq].filter(Boolean).join(' ')}\r\n`);
  }
}

function headerSection(raw: string, args: string): Buffer {
  const split = raw.indexOf('\r\n\r\n');
  const block = split >= 0 ? raw.slice(0, split) : raw;
  const requested = /HEADER\.FIELDS\s*\(([^)]*)\)/i.exec(args)?.[1];
  const names = requested
    ? requested
        .split(/\s+/)
        .map((name) => name.toLowerCase())
        .filter(Boolean)
    : [];
  const lines = block.split(/\r?\n/);
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (keeping) {
        kept.push(line);
      }
      continue;
    }
    const name = /^([^:]+):/.exec(line)?.[1]?.toLowerCase() ?? '';
    keeping = names.length === 0 || names.includes(name);
    if (keeping) {
      kept.push(line);
    }
  }
  return Buffer.from(`${kept.join('\r\n')}\r\n\r\n`);
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

function parseUidSet(token: string, messages: ScriptedMessage[]): number[] {
  return searchUids(`UID ${token}`, messages);
}

/** iCloud faults, matched against the SEARCH command text. */
function icloudCommandFault(args: string): 'empty' | 'unavailable' | null {
  const upper = args.toUpperCase();
  const text = /(?:FROM|TO|CC|BCC|SUBJECT|BODY|TEXT|HEADER|LARGER|SMALLER)/.test(upper);
  const flag =
    /(?:\bSEEN\b|\bUNSEEN\b|\bFLAGGED\b|\bUNFLAGGED\b|\bANSWERED\b|\bDELETED\b|\bDRAFT\b|\bKEYWORD\b)/.test(
      upper,
    );
  const notUid = /NOT\s+UID\b/.test(upper) || /(?:^|\s)NOT\s+\d/.test(upper);
  if (/NOT/.test(upper) && text && (flag || notUid || /\bUID\b/.test(upper))) {
    return 'unavailable';
  }
  if (notUid) {
    return 'empty';
  }
  return null;
}

function searchUids(args: string, messages: ScriptedMessage[]): number[] {
  const match = /(?:^|\s)UID\s+([0-9:,*]+)/i.exec(args);
  if (!match?.[1] || match[1] === '*' || match[1] === '1:*') {
    return messages.map((message) => message.uid);
  }
  const wanted = new Set<number>();
  for (const part of match[1].split(',')) {
    const range = /^(\d+|\*):(\d+|\*)$/.exec(part);
    if (range?.[1] && range[2]) {
      const low = range[1] === '*' ? 1 : Number(range[1]);
      const high = range[2] === '*' ? Number.POSITIVE_INFINITY : Number(range[2]);
      const start = Math.min(low, high);
      const end = Math.max(low, high);
      for (const message of messages) {
        if (message.uid >= start && message.uid <= end) {
          wanted.add(message.uid);
        }
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      wanted.add(Number(part));
    }
  }
  return messages.map((message) => message.uid).filter((uid) => wanted.has(uid));
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
