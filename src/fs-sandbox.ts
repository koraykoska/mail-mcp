import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { MailError } from './errors.js';

/**
 * Resolve `requested` and require its real path to stay inside `root`.
 * Symlink parents are followed. A final path component that does not exist yet is allowed
 * when its parent is inside the root, so a save can create a new file.
 */
export async function confineToRoot(requested: string, root: string): Promise<string> {
  if (requested.includes('\0')) {
    throw new MailError('INVALID_ARGUMENT', 'The path contains a NUL byte.');
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new MailError(
      'CONFIG_ERROR',
      `attachmentsDir "${root}" does not exist or cannot be resolved.`,
    );
  }
  const absolute = path.resolve(requested);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = await realpath(cursor);
      const full = path.join(real, ...missing);
      assertInside(rootReal, full);
      return full;
    } catch (error) {
      if (error instanceof MailError) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new MailError('INVALID_ARGUMENT', 'The path could not be resolved.');
      }
      const base = path.basename(cursor);
      if (base === '..' || base === '.') {
        throw new MailError('PERMISSION_DENIED', 'The path escapes attachmentsDir.');
      }
      missing.unshift(base);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new MailError('PERMISSION_DENIED', 'The path escapes attachmentsDir.');
      }
      cursor = parent;
    }
  }
}

export async function readBoundedFile(file: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile()) {
    throw new MailError('INVALID_ARGUMENT', 'Attachment path is not a regular file.');
  }
  if (info.size > maxBytes) {
    throw new MailError(
      'SIZE_LIMIT',
      `Attachment file is ${info.size} bytes, over the limit of ${maxBytes}.`,
    );
  }
  return readFile(file);
}

function assertInside(rootReal: string, full: string): void {
  const relative = path.relative(rootReal, full);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  if (relative === '' || parts.includes('..') || path.isAbsolute(relative)) {
    throw new MailError(
      'PERMISSION_DENIED',
      'The path is outside the configured attachmentsDir.',
      `Access is confined to ${rootReal}.`,
    );
  }
}
