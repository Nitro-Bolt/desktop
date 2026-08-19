import * as fs from 'node:fs';
import * as pathUtil from 'node:path';
import { computeSHA256, persistentFetch } from './lib.mjs';

const run = async () => {
  const releaseTag = process.env.PACKAGER_RELEASE_TAG;
  const releasesURL = releaseTag ?
    `https://api.github.com/repos/Nitro-Bolt/packager/releases/tags/${encodeURIComponent(releaseTag)}` :
    'https://api.github.com/repos/Nitro-Bolt/packager/releases';
  const releaseData = await (await persistentFetch(releasesURL)).json();
  const release = releaseTag ? releaseData : releaseData[0];

  if (!release || !Array.isArray(release.assets)) {
    throw new Error(`Could not find a packager release${releaseTag ? ` tagged ${releaseTag}` : ''}.`);
  }

  const packagerAsset = release.assets.find(asset => asset.name ===
    `nitrobolt-packager-standalone-${release.tag_name}.html`);
  if (!packagerAsset) {
    throw new Error(`Release ${release.tag_name} does not contain a standalone packager asset.`);
  }

  const packagerURL = packagerAsset.browser_download_url;
  console.log(`Source: ${packagerURL}`);
  const packagerBuffer = await (await persistentFetch(packagerURL)).arrayBuffer();

  const sha256 = computeSHA256(packagerBuffer);
  console.log(`SHA-256: ${sha256}`);

  fs.writeFileSync(pathUtil.join(import.meta.dirname, 'packager.json'), JSON.stringify({
    src: packagerURL,
    sha256,
  }, null, 2));
  console.log('This has only updated metadata; you still need to actually download the packager with download-packager.js');
};

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
