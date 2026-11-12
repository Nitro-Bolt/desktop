const settings = require('./settings');
const UpdateWindow = require('./windows/update');
const packageJSON = require('../package.json');
const privilegedFetch = require('./fetch');

const currentVersion = packageJSON.version;
const MANIFEST_URL = 'https://desktop.nitrobolt.org/version.json';
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const getCommitBuildBase = (version) => version.match(/^(\d+\.\d+\.\d+)-[0-9a-f]{7}$/)?.[1];

const validateURL = (value, hostname, pathname) => {
  if (typeof value !== 'string') {
    throw new Error('Update manifest is missing a URL.');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.pathname !== pathname ||
    url.username || url.password || url.port || url.search || url.hash) {
    throw new Error(`Invalid update URL: ${value}`);
  }
  return url.href;
};

const getStableVersion = (manifest, semverValid) => {
  const version = manifest.channels?.stable?.version;
  if (!STABLE_VERSION_PATTERN.test(version) || !semverValid(version)) {
    throw new Error('Update manifest has an invalid stable version.');
  }
  return version;
};

const getNightlyVersion = async (manifest, semverValid) => {
  const apiURL = validateURL(
    manifest.channels?.nightly?.api_url,
    'api.github.com',
    '/repos/Nitro-Bolt/desktop/releases/tags/nightly'
  );
  const release = await privilegedFetch.json(apiURL);
  const prefix = 'NitroBolt Desktop ';
  const version = typeof release.name === 'string' && release.name.startsWith(prefix) ?
    release.name.slice(prefix.length) : '';
  const targetCommit = typeof release.target_commitish === 'string' ? release.target_commitish : '';
  const completionMarker = `<!-- nitrobolt-nightly:${targetCommit} -->`;
  if (release.tag_name !== 'nightly' || release.draft || !release.prerelease ||
    !getCommitBuildBase(version) || !semverValid(version) || !/^[0-9a-f]{40}$/.test(targetCommit) ||
    !version.endsWith(`-${targetCommit.slice(0, 7)}`) || typeof release.body !== 'string' ||
    !release.body.includes(completionMarker)) {
    throw new Error('The nightly GitHub release has invalid metadata.');
  }
  return version;
};

const isNightlyUpdateAvailable = (current, latest, semverCompare) => {
  if (current === latest) return false;
  const currentBase = getCommitBuildBase(current) || current;
  const latestBase = getCommitBuildBase(latest);
  const baseComparison = semverCompare(currentBase, latestBase);
  if (baseComparison !== 0) return baseComparison < 0;
  return true;
};

/**
 * Determines whether the update checker is even allowed to be enabled
 * in this build of the app.
 * @returns {boolean}
 */
const isUpdateCheckerAllowed = () => {
  if (process.env.TW_DISABLE_UPDATE_CHECKER) {
    return false;
  }

  // Must be enabled in package.json
  return !!packageJSON.tw_update;
};

const checkForUpdates = async () => {
  if (!isUpdateCheckerAllowed() || settings.updateChecker === 'never') {
    return;
  }

  const json = await privilegedFetch.json(MANIFEST_URL);
  const oldestSafe = json.oldest_safe;

  // Imported lazily as it takes about 10ms to import
  const semverLt = require('semver/functions/lt');
  const semverCompare = require('semver/functions/compare');
  const semverValid = require('semver/functions/valid');
  const stableVersion = getStableVersion(json, semverValid);
  if (!STABLE_VERSION_PATTERN.test(oldestSafe) || !semverValid(oldestSafe)) {
    throw new Error('Update manifest has an invalid oldest safe version.');
  }
  if (semverLt(stableVersion, oldestSafe)) {
    throw new Error('Update manifest stable version is older than its oldest safe version.');
  }

  // Security updates can not be ignored.
  const securityComparisonVersion = getCommitBuildBase(currentVersion) || currentVersion;
  if (semverLt(securityComparisonVersion, oldestSafe)) {
    UpdateWindow.updateAvailable(currentVersion, stableVersion, true);
    return;
  }

  if (settings.updateChecker === 'security') {
    // Nothing further to check
    return;
  }

  const latest = settings.updateChecker === 'nightly' ?
    await getNightlyVersion(json, semverValid) : stableVersion;
  const now = Date.now();
  const ignoredUpdate = settings.ignoredUpdate;
  const ignoredUpdateUntil = settings.ignoredUpdateUntil * 1000;
  if (ignoredUpdate === latest && now < ignoredUpdateUntil) {
    // This update was ignored
    return;
  }

  const updateAvailable = settings.updateChecker === 'nightly' ?
    isNightlyUpdateAvailable(currentVersion, latest, semverCompare) :
    semverLt(currentVersion, latest);
  if (updateAvailable) {
    UpdateWindow.updateAvailable(currentVersion, latest, false);
  }
};

/**
 * @param {string} version
 * @param {Date} until
 */
const ignoreUpdate = async (version, until) => {
  settings.ignoredUpdate = version;
  settings.ignoredUpdateUntil = Math.floor(until.getTime() / 1000);
  await settings.save();
};

module.exports = {
  isUpdateCheckerAllowed,
  checkForUpdates,
  ignoreUpdate
};
