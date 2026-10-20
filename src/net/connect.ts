import { MailError } from '../errors.js';
import type { EndpointSettings } from '../config/schema.js';

export interface ConnectAddress {
  host: string;
  port: number;
}

/**
 * Where a socket actually dials, and the name TLS must verify.
 * `host`/`port` are the TCP target. `servername` is the logical hostname
 * (SNI and certificate check). Certificate verification stays enabled.
 */
export interface DialTarget {
  host: string;
  port: number;
  servername: string;
  logicalHost: string;
  logicalPort: number;
}

const PORT_MIN = 1;
const PORT_MAX = 65535;

/**
 * Parse `host:port` or `[ipv6]:port`. IPv6 literals must be in brackets.
 * The port is required so a bare hostname is not mistaken for a tunnel.
 */
export function parseConnectAddress(value: string): ConnectAddress {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MailError('CONFIG_ERROR', 'A connect address is empty.', 'Use host:port, for example 127.0.0.1:1993.');
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end <= 1 || trimmed[end + 1] !== ':') {
      throw new MailError(
        'CONFIG_ERROR',
        `Connect address "${trimmed}" is not [ipv6]:port.`,
        'Wrap IPv6 literals in brackets, for example [::1]:993.',
      );
    }
    const host = trimmed.slice(1, end);
    if (!host || host.includes('%')) {
      throw new MailError('CONFIG_ERROR', `Connect address "${trimmed}" has an invalid IPv6 literal.`);
    }
    return { host, port: parsePort(trimmed.slice(end + 2), trimmed) };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new MailError(
      'CONFIG_ERROR',
      `Connect address "${trimmed}" needs a port.`,
      'Use host:port. Wrap IPv6 literals in brackets, for example [::1]:993.',
    );
  }
  const host = trimmed.slice(0, colon);
  if (host.includes(':')) {
    throw new MailError(
      'CONFIG_ERROR',
      `Connect address "${trimmed}" looks like an IPv6 literal without brackets.`,
      'Use [2001:db8::1]:993.',
    );
  }
  return { host, port: parsePort(trimmed.slice(colon + 1), trimmed) };
}

function parsePort(value: string, original: string): number {
  if (!/^\d+$/.test(value)) {
    throw new MailError('CONFIG_ERROR', `Connect address "${original}" has a non-numeric port.`);
  }
  const port = Number(value);
  if (port < PORT_MIN || port > PORT_MAX) {
    throw new MailError('CONFIG_ERROR', `Connect address "${original}" has a port outside 1-65535.`);
  }
  return port;
}

/** TCP target plus the hostname used for SNI and certificate verification. */
export function dialTarget(endpoint: Pick<EndpointSettings, 'host' | 'port' | 'connectHost' | 'connectPort' | 'tls'>): DialTarget {
  const logicalHost = endpoint.host;
  const logicalPort = endpoint.port;
  const host = endpoint.connectHost ?? logicalHost;
  const port = endpoint.connectPort ?? logicalPort;
  const servername = endpoint.tls.servername ?? logicalHost;
  return { host, port, servername, logicalHost, logicalPort };
}
