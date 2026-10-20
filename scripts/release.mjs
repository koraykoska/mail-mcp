import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const level = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major', 'prerelease'].includes(level)) {
  process.stderr.write('Usage: npm run release -- patch|minor|major|prerelease\n');
  process.exit(1);
}
execFileSync('npm', ['version', level, '--no-git-tag-version'], { stdio: 'inherit' });
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const entry = `## ${version}\n\n- Release ${version}.\n\n`;
if (!changelog.includes(`## ${version}`)) {
  writeFileSync('CHANGELOG.md', changelog.replace('# Changelog\n\n', `# Changelog\n\n${entry}`));
}
execFileSync('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
execFileSync('git', ['commit', '-m', `Release ${version}`]);
execFileSync('git', ['tag', `v${version}`]);
execFileSync('git', ['push', 'origin', 'HEAD', '--follow-tags']);
process.stdout.write(`Tagged v${version}\n`);
