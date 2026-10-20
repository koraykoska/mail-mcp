/**
 * Library entry point. The `mail-mcp` executable lives in {@link ./cli.ts}.
 */
export { PACKAGE_NAME, SERVER_NAME, VERSION } from './version.js';
export { MailError, MAIL_ERROR_CODES, mapTransportError } from './errors.js';
export type { MailErrorCode } from './errors.js';
export { loadConfig, requireAccount } from './config/load.js';
export type { AppConfig, ResolvedAccount } from './config/schema.js';
export { PROVIDERS, PROVIDER_IDS } from './config/providers.js';
export { createRuntime } from './runtime.js';
export type { Runtime } from './runtime.js';
export { createMcpServer } from './server.js';
export { MailService } from './service/mail-service.js';
export { TOOLS } from './tools/catalog.js';
export { run, parseArgs, helpText } from './cli.js';
