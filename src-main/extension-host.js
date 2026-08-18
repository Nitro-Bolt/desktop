const EXTENSION_HOST_PREFIXES = Object.freeze({
  'extensions.turbowarp.org': 'turbowarp',
  'extensions.nitrobolt.org': 'nitrobolt'
});

const getExtensionHostPrefix = (url) => {
  if (url.protocol !== 'https:') {
    return null;
  }

  const prefix = EXTENSION_HOST_PREFIXES[url.hostname];
  return prefix === undefined ? null : prefix;
};

const getLocalExtensionPath = (url) => {
  const prefix = getExtensionHostPrefix(url);
  if (prefix === null) {
    return null;
  }

  const pathname = url.pathname.replace(/^\/+/, '');
  return prefix ? `${prefix}/${pathname}` : pathname;
};

const getLocalExtensionURL = (url) => {
  const path = getLocalExtensionPath(url);
  if (path === null) {
    return null;
  }

  return `nb-extensions://./${path}${url.search}`;
};

module.exports = {
  getExtensionHostPrefix,
  getLocalExtensionPath,
  getLocalExtensionURL
};
