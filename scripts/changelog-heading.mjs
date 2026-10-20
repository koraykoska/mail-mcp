import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = `# Changelog\n\n`;
if (!changelog.startsWith(heading)) {
  process.stderr.write('CHANGELOG.md must start with a Changelog heading.\n');
  process.exit(1);
}
if (changelog.includes(`## ${version}\n`)) {
  process.exit(0);
}
const entry = `## ${version}\n\n- Release ${version}.\n\n`;
writeFileSync('CHANGELOG.md', `${heading}${entry}${changelog.slice(heading.length)}`);
