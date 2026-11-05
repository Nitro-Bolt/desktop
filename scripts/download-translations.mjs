import fs from 'node:fs';
import pathUtil from 'node:path';
import {fileURLToPath} from 'node:url';
import {transifexApi, RESOURCE, resourceId, projectId} from './transifex-common.mjs';

const root = pathUtil.resolve(pathUtil.dirname(fileURLToPath(import.meta.url)), '..');
const resources = {
  desktop: {
    source: 'src-main/l10n/en.json',
    output: 'src-main/l10n/generated-translations.json'
  },
  'desktop-website': {
    source: 'docs/l10n/en.json',
    output: 'docs/l10n/generated-translations.json'
  }
};
const resource = resources[RESOURCE];
if (!resource) throw new Error(`Unknown translation resource: ${RESOURCE}`);
const sourceWithContext = JSON.parse(fs.readFileSync(pathUtil.join(root, resource.source), 'utf8'));
const source = {};
for (const [id, value] of Object.entries(sourceWithContext)) {
  source[id] = value.string;
}

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

const fetchJson = async (url) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    if (attempt === 4) throw new Error(`HTTP ${response.status} downloading translations.`);
    await sleep(1000 * (attempt + 1));
  }
};

const translations = {};
const statistics = transifexApi.resource_language_stats.filter({
  project: projectId,
  resource: resourceId
}).all();

for await (const languageData of statistics) {
  if (languageData.attributes.translated_strings === 0) continue;
  const localeCode = languageData.id.match(/\bl:([\w-]+)/)?.[1];
  if (!localeCode) continue;
  const locale = localeCode.toLowerCase().replace(/_/g, '-');
  if (locale === 'en') continue;

  const url = await transifexApi.ResourceTranslationsAsyncDownload.download({
    mode: 'reviewed',
    resource: {
      data: {
        id: resourceId,
        type: 'resources'
      }
    },
    language: {
      data: {
        id: `l:${localeCode}`,
        type: 'languages'
      }
    }
  });
  const downloaded = await fetchJson(url);
  const localeStrings = {};
  for (const [id, value] of Object.entries(downloaded)) {
    const translated = typeof value === 'string' ? value : value?.string;
    if (typeof translated !== 'string' || translated.length === 0 || translated === source[id]) continue;
    if (!Object.prototype.hasOwnProperty.call(source, id)) continue;
    const sourcePlaceholders = [...source[id].matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    const translatedPlaceholders = [...translated.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(translatedPlaceholders)) {
      console.warn(`Skipping ${locale} ${id}: placeholders do not match.`);
      continue;
    }
    localeStrings[id] = translated;
  }
  if (Object.keys(localeStrings).length > 0) {
    translations[locale] = localeStrings;
  }
}

const sortedTranslations = {};
for (const locale of Object.keys(translations).sort()) {
  sortedTranslations[locale] = {};
  for (const id of Object.keys(translations[locale]).sort()) {
    sortedTranslations[locale][id] = translations[locale][id];
  }
}

const output = pathUtil.join(root, resource.output);
fs.writeFileSync(output, `${JSON.stringify(sortedTranslations, null, 2)}\n`);
console.log(`Downloaded ${Object.keys(translations).length} Desktop locales.`);
