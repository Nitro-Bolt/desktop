const englishTranslationsWithContext = require('./en.json');
const otherTranslations = require('./generated-translations.json');
const settings = require('../settings');

const englishTranslations = {};
for (const [id, message] of Object.entries(englishTranslationsWithContext)) {
  englishTranslations[id] = message.string;
}

let currentLocale;
let currentStrings;

const loadTranslations = (locale) => {
  const result = Object.assign({}, englishTranslations);
  const possibleLocales = [locale];
  if (locale.includes('-')) {
    possibleLocales.push(locale.split('-')[0]);
  }
  for (const possibleLocale of possibleLocales) {
    if (otherTranslations[possibleLocale]) {
      Object.assign(result, otherTranslations[possibleLocale]);
      break;
    }
  }
  return result;
};

const updateLocale = (locale) => {
  currentLocale = typeof locale === 'string' ? locale : 'en';
  currentStrings = loadTranslations(currentLocale);
};

const translate = (id) => currentStrings[id] || id;

const tranlateOrNull = (id) => currentStrings[id] || null;

const getLocale = () => currentLocale;

const getStrings = () => currentStrings;

updateLocale(settings.locale);

module.exports = {
  updateLocale,
  translate,
  tranlateOrNull,
  getLocale,
  getStrings
};
