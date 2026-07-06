import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../../package.json') as {
  name: string;
  version: string;
};

/** npm package name (may be scoped) — used for self-update and docs. */
export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
