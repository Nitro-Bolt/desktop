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

const exportFile = async (prefix, relativePath, file) => {
  // This part is unfortunately still synchronous
  const contents = await file.read();
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
