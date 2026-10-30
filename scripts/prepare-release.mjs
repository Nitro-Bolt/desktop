import * as fs from 'node:fs';
import * as pathUtil from 'node:path';

const root = pathUtil.join(import.meta.dirname, '..');
const releaseType = process.argv[2];
const notes = process.env.RELEASE_NOTES || '';

if (releaseType !== 'current' && releaseType !== 'update' && releaseType !== 'bugfix') {
  throw new Error('Release type must be current, update, or bugfix.');
}

const formattedNotes = notes
  .split(/\r?\n/)
  .map(note => note.trim().replace(/^[-*]\s*/, ''))
  .filter(Boolean)
  .map(note => ` - ${note}`)
  .join('\n');
if (!formattedNotes) {
  throw new Error('At least one release note is required.');
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

const versionManifestPath = pathUtil.join(root, 'docs/version.json');
const versionManifest = JSON.parse(fs.readFileSync(versionManifestPath, 'utf8'));
if (typeof versionManifest.oldest_safe !== 'string') {
  throw new Error('The website version manifest is missing oldest_safe.');
}

const homepagePath = pathUtil.join(root, 'docs/index.html');
const homepage = fs.readFileSync(homepagePath, 'utf8');
const homepageVersionPattern = /const VERSION *= *["'][\d\w.-]+["']/;
if (!homepageVersionPattern.test(homepage)) {
  throw new Error('Could not find the website version.');
}
const updatedHomepage = homepage.replace(homepageVersionPattern, `const VERSION = '${version}'`);

const now = new Date();
const date = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
const changelogPath = pathUtil.join(root, 'changelog.md');
const changelog = fs.readFileSync(changelogPath, 'utf8');
const firstRelease = changelog.indexOf('\n# ');
if (firstRelease === -1) {
  throw new Error('Could not find the first changelog release.');
}

const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const existingReleasePattern = new RegExp(`^# ${escapedVersion} \\([^\\r\\n]+\\)[\\s\\S]*?(?=^# |(?![\\s\\S]))`, 'm');
const existingRelease = changelog.match(existingReleasePattern);
if (releaseType !== 'current' && existingRelease) {
  throw new Error(`Changelog already contains version ${version}.`);
}

const existingReleaseDate = existingRelease?.[0].match(/^# [^\r\n]+ \(([^\r\n]+)\)/)?.[1];
const releaseSection = `# ${version} (${existingReleaseDate || date})\n\n${formattedNotes}\n\n`;
const updatedChangelog = existingRelease ?
  changelog.replace(existingReleasePattern, releaseSection) :
  `${changelog.slice(0, firstRelease + 1)}${releaseSection}${changelog.slice(firstRelease + 1)}`;

// All validation above must finish before any files are changed.
packageJSON.version = version;
versionManifest.latest = version;
versionManifest.latest_unstable = version;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJSON, null, 2)}\n`);
fs.writeFileSync(versionManifestPath, `${JSON.stringify(versionManifest, null, 2)}\n`);
fs.writeFileSync(homepagePath, updatedHomepage);
fs.writeFileSync(changelogPath, updatedChangelog);

await import('./generate-changelogs.mjs');

process.stdout.write(version);
