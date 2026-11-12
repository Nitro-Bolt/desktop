import fs from 'node:fs';
import pathUtil from 'node:path';

const suffix = process.argv[2];
if (!/^[0-9a-f]{7}$/.test(suffix)) {
  throw new Error('The build version suffix must be the first 7 characters of a lowercase commit hash.');
}

const packagePath = pathUtil.join(import.meta.dirname, '..', 'package.json');
const packageJSON = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageJSON.version)) {
  throw new Error(`Expected a stable base version, received ${packageJSON.version}.`);
}

packageJSON.version = `${packageJSON.version}-${suffix}`;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJSON, null, 2)}\n`);
console.log(packageJSON.version);
