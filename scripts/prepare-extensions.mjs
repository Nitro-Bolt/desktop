import pathUtil from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import TurboWarpBuilder from '@turbowarp/extensions/builder';
import NitroBoltBuilder from '@nitro-bolt/extensions/builder';

const mode = 'desktop';

const outputDirectory = pathUtil.join(import.meta.dirname, '../dist-extensions/');
fs.rmSync(outputDirectory, {
  recursive: true,
  force: true,
});

const brotliCompress = promisify(zlib.brotliCompress);

const namespaceAssetURLs = (contents, prefix, relativePath) => {
  if (!prefix || !relativePath.toLowerCase().endsWith('.html') || typeof contents !== 'string') {
    return contents;
  }

  // The gallery builders generate root-relative asset URLs. Once each gallery
  // is mounted under its own directory, those URLs need the gallery prefix.
  return contents
    .replace(/((?:src|href)=["'])\/(?!\/)/g, `$1/${prefix}/`)
    .replace(/(url\(\s*)\/(?!\/)/g, `$1/${prefix}/`);
};

const exportFile = async (prefix, relativePath, file) => {
  // This part is unfortunately still synchronous
  const contents = namespaceAssetURLs(await file.read(), prefix, relativePath);
  const outputPath = pathUtil.join(prefix, relativePath.replace(/^[/\\]+/, ''));
  console.log(`Generated ${outputPath}`);

  const compressed = await brotliCompress(contents);

  const directoryName = pathUtil.dirname(outputPath);
  await fsPromises.mkdir(pathUtil.join(outputDirectory, directoryName), {
    recursive: true
  });

  await fsPromises.writeFile(pathUtil.join(outputDirectory, `${outputPath}.br`), compressed)

  console.log(`Compressed ${outputPath}`);
};

const builders = [
  {
    name: 'TurboWarp',
    Builder: TurboWarpBuilder,
    prefix: 'turbowarp'
  },
  {
    name: 'NitroBolt',
    Builder: NitroBoltBuilder,
    // Keep the two extension galleries separate so identical slugs can coexist.
    prefix: 'nitrobolt'
  }
];

for (const {name, Builder, prefix} of builders) {
  const builder = new Builder(mode);
  const build = await builder.build();
  console.log(`Built ${name} extensions (mode: ${mode})`);

  await Promise.all(
    Object.entries(build.files).map(([relativePath, file]) => exportFile(prefix, relativePath, file))
  );
}

console.log(`Exported extensions to ${outputDirectory}`);
