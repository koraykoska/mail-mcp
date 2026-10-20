import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
  name: string;
}

const pkg = require('../package.json') as PackageJson;

/** Published package name (`mail-mcp`). */
export const PACKAGE_NAME: string = pkg.name;

/** Semver of this build, read from package.json. */
export const VERSION: string = pkg.version;
