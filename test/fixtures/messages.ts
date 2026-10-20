export function simpleMessage(
  options: {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string;
  } = {},
): Buffer {
  const lines = [
    `From: ${options.from ?? 'Ada Lovelace <ada@example.com>'}`,
    `To: ${options.to ?? 'User <user@example.com>'}`,
    `Subject: ${options.subject ?? 'Hello'}`,
    'Date: Tue, 01 Jan 2026 00:00:00 +0000',
    `Message-ID: ${options.messageId ?? '<m1@example.com>'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (options.inReplyTo) {
    lines.push(`In-Reply-To: ${options.inReplyTo}`);
  }
  if (options.references) {
    lines.push(`References: ${options.references}`);
  }
  lines.push('', options.text ?? 'Hello from the fixture.');
  return Buffer.from(lines.join('\r\n'));
}

export const multipartMixed = Buffer.from(
  [
    'From: Ada <ada@example.com>',
    'To: user@example.com',
    'Subject: Files',
    'Date: Tue, 01 Jan 2026 00:00:00 +0000',
    'Message-ID: <mix@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bnd"',
    '',
    '--bnd',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'See attached.',
    '--bnd',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="notes.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fixture').toString('base64'),
    '--bnd--',
    '',
  ].join('\r\n'),
);

export const htmlAlternative = Buffer.from(
  [
    'From: =?utf-8?Q?Ada_Lovelace?= <ada@example.com>',
    'To: =?utf-8?B?5oiR5Lus?= <user@example.com>',
    'Subject: =?utf-8?Q?Caf=C3=A9?=',
    'Date: Tue, 01 Jan 2026 00:00:00 +0000',
    'Message-ID: <html@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Cafe plain',
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>Cafe <b>html</b></p></body></html>',
    '--alt--',
    '',
  ].join('\r\n'),
);

export const nestedRfc822 = Buffer.from(
  [
    'From: ada@example.com',
    'To: user@example.com',
    'Subject: Nested',
    'Message-ID: <outer@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: message/rfc822',
    '',
    'From: inner@example.com',
    'To: ada@example.com',
    'Subject: Inside',
    'Message-ID: <inner@example.com>',
    '',
    'Inner body',
    '',
  ].join('\r\n'),
);

export const brokenEncoding = Buffer.from(
  [
    'From: ada@example.com',
    'To: user@example.com',
    'Subject: =?unknown?Q?broken?=',
    'Content-Type: text/plain; charset=x-not-a-charset',
    'Content-Transfer-Encoding: 8bit',
    '',
    'caf\u00e9 raw',
    '',
  ].join('\r\n'),
);

export const calendarInvite = Buffer.from(
  [
    'From: ada@example.com',
    'To: user@example.com',
    'Subject: Standup',
    'Message-ID: <cal@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="cal"',
    '',
    '--cal',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please join.',
    '--cal',
    'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
    'Content-Disposition: attachment; filename="invite.ics"',
    '',
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR',
    '--cal--',
    '',
  ].join('\r\n'),
);

export const smimeSigned = Buffer.from(
  [
    'From: ada@example.com',
    'To: user@example.com',
    'Subject: Signed',
    'Message-ID: <smime@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="sig"',
    '',
    '--sig',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Signed body',
    '--sig',
    'Content-Type: application/pkcs7-signature; name="smime.p7s"',
    'Content-Disposition: attachment; filename="smime.p7s"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('not-a-real-signature').toString('base64'),
    '--sig--',
    '',
  ].join('\r\n'),
);
