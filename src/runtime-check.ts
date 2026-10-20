import { MailError } from './errors.js';

/**
 * mail-mcp needs Node 22 or newer. Bun hosts the program on its own runtime,
 * so an older Node beside Bun is fine when `process.versions.bun` is set.
 */
export function assertSupportedNode(version: string, bunVersion?: string): void {
  if (bunVersion) {
    return;
  }
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new MailError(
      'CONFIG_ERROR',
      `Node.js ${version} is not supported. mail-mcp requires Node.js 22 or newer.`,
      'On a machine with an older Node, run bunx --bun @koraykoska/mail-mcp.',
    );
  }
}
