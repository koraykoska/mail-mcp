import { chmod, mkdir, realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { MailError } from './errors.js';

/** Mode applied to an attachmentsDir this process creates. An existing directory is left unchanged. */
export const ATTACHMENTS_DIR_MODE = 0o700;

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
      'mail-mcp creates the configured attachmentsDir when it is missing. Check that its parent exists and is writable by this process.',
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

/**
 * Create the configured attachmentsDir when it is missing.
 * Only `root` is created (mkdir -p). A caller path is never used as a directory to create.
 * A directory this call creates is mode 0700. An existing directory keeps its mode.
 * Returns the real path. A later deletion is repaired by calling this again.
 */
export async function ensureAttachmentsDir(root: string): Promise<string> {
  if (root.includes('\0')) {
    throw new MailError(
      'CONFIG_ERROR',
      'attachmentsDir contains a NUL byte.',
      'The config key is attachmentsDir.',
    );
  }
  let existed = false;
  try {
    const info = await stat(root);
    existed = true;
    if (!info.isDirectory()) {
      throw new MailError(
        'CONFIG_ERROR',
        `attachmentsDir "${root}" exists and is not a directory.`,
        'Set the attachmentsDir config key to a directory path.',
      );
    }
  } catch (error) {
    if (error instanceof MailError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw attachmentDirError(root, error);
    }
  }
  if (!existed) {
    try {
      await mkdir(root, { recursive: true, mode: ATTACHMENTS_DIR_MODE });
      await chmod(root, ATTACHMENTS_DIR_MODE);
    } catch (error) {
      throw attachmentDirError(root, error);
    }
  }
  try {
    const real = await realpath(root);
    const info = await stat(real);
    if (!info.isDirectory()) {
      throw new MailError(
        'CONFIG_ERROR',
        `attachmentsDir "${root}" does not resolve to a directory.`,
        'Set the attachmentsDir config key to a directory path.',
      );
    }
    return real;
  } catch (error) {
    if (error instanceof MailError) {
      throw error;
    }
    throw attachmentDirError(root, error);
  }
}

export async function readBoundedFile(file: string, maxBytes: number): Promise<Buffer> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new MailError('INVALID_ARGUMENT', 'The attachment path could not be read.');
    }
    const parent = path.dirname(file);
    let parentMissing = false;
    try {
      await stat(parent);
    } catch (parentError) {
      const parentCode = (parentError as NodeJS.ErrnoException).code;
      if (parentCode === 'ENOENT' || parentCode === 'ENOTDIR') {
        parentMissing = true;
      }
    }
    if (parentMissing) {
      const missing = await firstMissing(file);
      throw new MailError(
        'NOT_FOUND',
        `Attachment directory "${missing}" does not exist.`,
        'mail-mcp creates only the configured attachmentsDir. It does not create a directory from an attachment path. Create that directory yourself, or place the file directly in attachmentsDir.',
      );
    }
    throw new MailError(
      'NOT_FOUND',
      `Attachment file "${file}" does not exist.`,
      'Place the file inside attachmentsDir. mail-mcp reads the path and does not create the file.',
    );
  }
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

function attachmentDirError(root: string, error: unknown): MailError {
  const detail = error instanceof Error ? error.message : 'unknown error';
  const code = (error as NodeJS.ErrnoException).code;
  const hint =
    code === 'EACCES' || code === 'EPERM'
      ? `The process cannot create attachmentsDir "${root}". Grant write permission on its parent, or set attachmentsDir to a directory this process can create.`
      : `Could not create the directory named by the attachmentsDir config key ("${root}"). Check that its parent exists and is writable by this process.`;
  return new MailError(
    'CONFIG_ERROR',
    `Could not create attachmentsDir "${root}": ${detail}`,
    hint,
  );
}

/** The first path component of `file` that does not exist, walking from the leaf toward the root. */
async function firstMissing(file: string): Promise<string> {
  let cursor = file;
  let missing = file;
  for (;;) {
    try {
      await stat(cursor);
      return missing;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return missing;
      }
      missing = cursor;
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return missing;
      }
      cursor = parent;
    }
  }
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
