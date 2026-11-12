import fs from 'node:fs';
import pathUtil from 'node:path';

const version = process.argv[2];
const securityUpdate = process.env.SECURITY_UPDATE === 'true';

const parseVersion = (value, name) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value.split('.').map(Number);
};

const compareVersions = (a, b) => {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

const versionParts = parseVersion(version, 'release version');
const manifestPath = pathUtil.join(import.meta.dirname, '..', 'docs/version.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const stableParts = parseVersion(manifest.channels?.stable?.version, 'stable version');
const oldestSafeParts = parseVersion(manifest.oldest_safe, 'oldest safe version');

if (compareVersions(versionParts, stableParts) < 0) {
  throw new Error(`Release ${version} can not replace newer stable version ${manifest.channels.stable.version}.`);
}
if (compareVersions(versionParts, oldestSafeParts) < 0) {
  throw new Error(`Release ${version} can not be older than oldest safe version ${manifest.oldest_safe}.`);
}

manifest.channels.stable = {version};
if (securityUpdate) {
  manifest.oldest_safe = version;
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
