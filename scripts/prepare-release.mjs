import * as fs from 'node:fs';
import * as pathUtil from 'node:path';

const root = pathUtil.join(import.meta.dirname, '..');
const releaseType = process.argv[2];
const notes = process.env.RELEASE_NOTES || '';

if (releaseType !== 'current' && releaseType !== 'update' && releaseType !== 'bugfix') {
  throw new Error('Release type must be current, update, or bugfix.');
}

const packagePath = pathUtil.join(root, 'package.json');
const packageJSON = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const versionParts = packageJSON.version.split('.').map(Number);

if (versionParts.length !== 3 || versionParts.some(part => !Number.isInteger(part)) || versionParts[0] !== 1) {
  throw new Error(`Expected a 1.x.y version, received ${packageJSON.version}.`);
}

if (releaseType === 'update') {
  versionParts[1] += 1;
  versionParts[2] = 0;
} else if (releaseType === 'bugfix') {
  versionParts[2] += 1;
}

const version = versionParts.join('.');
packageJSON.version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJSON, null, 2)}\n`);

const versionManifestPath = pathUtil.join(root, 'docs/version.json');
const versionManifest = JSON.parse(fs.readFileSync(versionManifestPath, 'utf8'));
versionManifest.latest = version;
versionManifest.latest_unstable = version;
fs.writeFileSync(versionManifestPath, `${JSON.stringify(versionManifest, null, 2)}\n`);

const homepagePath = pathUtil.join(root, 'docs/index.html');
const homepage = fs.readFileSync(homepagePath, 'utf8');
const homepageVersionPattern = /const VERSION *= *["'][\d\w.-]+["']/;
if (!homepageVersionPattern.test(homepage)) {
  throw new Error('Could not find the website version.');
}
const updatedHomepage = homepage.replace(homepageVersionPattern, `const VERSION = '${version}'`);
fs.writeFileSync(homepagePath, updatedHomepage);

const formattedNotes = notes
  .split(/\r?\n/)
  .map(note => note.trim().replace(/^[-*]\s*/, ''))
  .filter(Boolean)
  .map(note => ` - ${note}`)
  .join('\n');
if (!formattedNotes) {
  throw new Error('At least one release note is required.');
}

const now = new Date();
const date = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
const changelogPath = pathUtil.join(root, 'changelog.md');
const changelog = fs.readFileSync(changelogPath, 'utf8');
const firstRelease = changelog.indexOf('\n# ');
if (firstRelease === -1) {
  throw new Error('Could not find the first changelog release.');
}
const newRelease = `\n# ${version} (${date})\n\n${formattedNotes}\n`;
fs.writeFileSync(changelogPath, `${changelog.slice(0, firstRelease)}${newRelease}${changelog.slice(firstRelease)}`);

await import('./generate-changelogs.mjs');

process.stdout.write(version);
