import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
  name: string;
}

const pkg = require('../package.json') as PackageJson;

/** Published npm package name (`@koraykoska/mail-mcp`). */
export const PACKAGE_NAME: string = pkg.name;

/** MCP server and executable name. The npm package is scoped; this stays short. */
export const SERVER_NAME = 'mail-mcp';

/** Semver of this build, read from package.json. */
export const VERSION: string = pkg.version;
