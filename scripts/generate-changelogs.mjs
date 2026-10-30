import * as fs from 'node:fs';
import * as pathUtil from 'node:path';

/**
 * @typedef Release
 * @property {string} version
 * @property {Date} date
 * @property {string[]} notes
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

const isLessThanOrEqual = (a, b) => {
  const [aCore, aPrerelease] = a.split('-', 2);
  const [bCore, bPrerelease] = b.split('-', 2);
  const aParts = aCore.split('.');
  const bParts = bCore.split('.');
  for (let index = 0; index < 3; index++) {
    const aPart = Number(aParts[index]);
    const bPart = Number(bParts[index]);
    if (aPart !== bPart) {
      return aPart < bPart;
    }
  }
  if (aPrerelease === bPrerelease) return true;
  if (!aPrerelease) return false;
  if (!bPrerelease) return true;
  return aPrerelease <= bPrerelease;
};

const escapeXmlText = (xml) => xml.replace(/[<>&]/g, c => {
  // We don't need to escape quotes because we only use this for text, not attributes
  switch (c) {
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '&': return '&amp;';
  }
});

/** @returns {Release[]} */
const parse = () => {
  const releaseData = [];
  const source = fs.readFileSync(pathUtil.join(import.meta.dirname, '../changelog.md'), 'utf-8');
  const sections = source.split(/^# /gm);

  // Remove the information section at the start
  sections.shift();

  for (const section of sections) {
    const versionMatch = section.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/);
    const dateMatch = section.match(/\((\d+-\d+-\d+)\)/);
    if (!versionMatch || !dateMatch) {
      throw new Error('Invalid changelog release heading.');
    }
    const version = versionMatch[0];
    const [year, month, day] = dateMatch[1].split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error(`Invalid changelog date for ${version}.`);
    }

    /** @type {Release} */
    const data = {
      version,
      date,
      notes: []
    };

    for (const note of section.matchAll(/^ *[-*] *(.+)/gm)) {
      data.notes.push(note[1]);
    }

    releaseData.push(data);
  }
  return releaseData;
};

/**
 * @param {Release[]} releases
 */
const generateHomepage = (releases) => {
  const path = pathUtil.join(import.meta.dirname, '../docs/index.html');
  let source = fs.readFileSync(path, 'utf-8');
  const releasedVersionMatch = source.match(/const VERSION *= *["']([\d\w.\-]+)["']/i);
  if (!releasedVersionMatch) {
    throw new Error('Could not find the website version.');
  }
  const releasedVersion = releasedVersionMatch[1];

  let html = '';
  for (const {version, date, notes} of releases) {
    if (isLessThanOrEqual(version, releasedVersion)) {
      html += `        <div data-version="${version}">\n`;
      html += `          <h3>v${version} (${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${date.getUTCFullYear()})</h3>\n`;
      html += '          <ul>\n';
      for (const note of notes) {
        html += `            <li>${escapeXmlText(note)}</li>\n`;
      }
      html += '          </ul>\n';
      html += '        </div>\n';
    }
  }

  const changelogPattern = /<!-- CHANGELOG_START -->[\s\S]*<!-- CHANGELOG_END -->/m;
  if (!changelogPattern.test(source)) {
    throw new Error('Could not find the website changelog markers.');
  }
  source = source.replace(changelogPattern, `<!-- CHANGELOG_START -->\n${html}        <!-- CHANGELOG_END -->`);
  fs.writeFileSync(path, source);
};

/**
 * @param {Release[]} releases
 */
const generateMetainfo = (releases) => {
  let xml = '';
  for (const {version, date, notes} of releases) {
    xml += `    <release version="${version}" date="${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}">\n`;
    xml += `      <url type="details">https://github.com/Nitro-Bolt/desktop/releases/tag/v${version}</url>\n`;
    xml += '      <description>\n';
    xml += '        <ul>\n';
    for (let note of notes) {
      // This file is only used on Linux
      if (note.startsWith('Windows:') || note.startsWith('macOS:')) {
        continue;
      }
      note = note.replace(/^Linux: */, '');
      xml += `          <li>${escapeXmlText(note)}</li>\n`;
    }
    xml += '        </ul>\n';
    xml += '      </description>\n';
    xml += '    </release>\n';
  }

  const path = pathUtil.join(import.meta.dirname, '../linux-files/org.nitrobolt.NitroBolt.metainfo.xml');
  let source = fs.readFileSync(path, 'utf-8');
  const releasesPattern = /<releases>[\s\S]*<\/releases>/m;
  if (!releasesPattern.test(source)) {
    throw new Error('Could not find the Linux metadata releases section.');
  }
  source = source.replace(releasesPattern, `<releases>\n${xml}  </releases>`);
  fs.writeFileSync(path, source);
};

/**
 * @param {Release[]} releases
 */
const generateJSON = (releases) => {
  const data = [];
  for (const {version, date, notes} of releases) {
    data.push({
      version,
      date: `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`,
      notes
    });
  }

  const path = pathUtil.join(import.meta.dirname, '../docs/changelog.json');
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
};

const releases = parse();
generateHomepage(releases);
generateMetainfo(releases);
generateJSON(releases);
