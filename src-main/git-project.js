const AdmZip = require('adm-zip');
const crypto = require('crypto');
const fsPromises = require('fs/promises');
const path = require('path');

const PROJECT_FILE = 'project.json';
const TARGET_FILE = 'target.json';
const BLOCKS_FILE = 'blocks.json';
const ASSET_DIRECTORY = 'assets';
const RESERVED_TARGET_FOLDERS = new Set([
  '.git',
  '.gitattributes',
  'assets',
  'project.json',
  'readme.md'
]);
const BINARY_ASSET_EXTENSIONS = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.sb3',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip'
]);

const defineOwn = (object, key, value) => {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
};

const sortValue = value => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) defineOwn(result, key, sortValue(value[key]));
  return result;
};

const assertRepository = async repoPath => {
  const resolved = await fsPromises.realpath(path.resolve(repoPath));
  const stat = await fsPromises.stat(path.join(resolved, '.git'));
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('Selected folder is not a Git repository');
  return resolved;
};

const assertManagedPath = async (repository, relativePath) => {
  if (typeof relativePath !== 'string' || relativePath.includes('\\')) {
    throw new Error(`Invalid managed project path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath);
  const fullPath = path.resolve(repository, ...normalized.split('/'));
  const relative = path.relative(repository, fullPath);
  if (normalized !== relativePath || relative === '..' || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)) throw new Error(`Invalid managed project path: ${relativePath}`);
  let currentPath = repository;
  for (const part of normalized.split('/')) {
    currentPath = path.join(currentPath, part);
    try {
      if ((await fsPromises.lstat(currentPath)).isSymbolicLink()) {
        throw new Error(`Managed project path cannot contain a symbolic link: ${relativePath}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return fullPath;
};

const getProjectJSON = zip => {
  const entry = zip.getEntry(PROJECT_FILE);
  if (!entry) throw new Error(`Project archive does not contain ${PROJECT_FILE}`);
  return JSON.parse(entry.getData().toString('utf8'));
};

const inputReferences = (value, blocks, references = []) => {
  if (!Array.isArray(value)) return references;
  for (let index = 1; index <= 2 && index < value.length; index++) {
    if (typeof value[index] === 'string' && blocks[value[index]]) references.push(value[index]);
  }
  return references;
};

const isTopLevelBlock = block => Array.isArray(block) ?
  [12, 13, 14].includes(block[0]) && block.length >= 5 : Boolean(block && block.topLevel);

const blockPosition = block => Array.isArray(block) ? {x: block[3] || 0, y: block[4] || 0} : {
  x: block.x || 0,
  y: block.y || 0
};

const orderedScripts = blocks => {
  const visited = new Set();
  const visit = (id, ordered) => {
    if (!id || visited.has(id) || !blocks[id]) return;
    visited.add(id);
    ordered.push(id);
    const block = blocks[id];
    if (Array.isArray(block)) return;
    Object.keys(block.inputs || {}).sort().forEach(name => {
      inputReferences(block.inputs[name], blocks).forEach(reference => visit(reference, ordered));
    });
    visit(block.next, ordered);
  };
  const roots = Object.keys(blocks).filter(id => isTopLevelBlock(blocks[id])).sort((leftId, rightId) => {
    const left = blockPosition(blocks[leftId]);
    const right = blockPosition(blocks[rightId]);
    return left.y - right.y || left.x - right.x || leftId.localeCompare(rightId);
  });
  const scripts = [];
  roots.forEach(root => {
    const ordered = [];
    visit(root, ordered);
    scripts.push({root, blocks: ordered});
  });
  Object.keys(blocks).sort().forEach(id => {
    if (visited.has(id)) return;
    const ordered = [];
    visit(id, ordered);
    scripts.push({root: id, blocks: ordered});
  });
  return scripts;
};

const targetDocuments = (target, workspaceTarget = null) => {
  const metadata = JSON.parse(JSON.stringify(target));
  const blocks = metadata.blocks || {};
  const comments = metadata.comments || {};
  delete metadata.blocks;
  delete metadata.comments;
  const xmlByRoot = new Map(((workspaceTarget && workspaceTarget.scripts) || [])
    .map(script => [script.id, script.xml]));
  const claimedComments = new Set();
  const scripts = orderedScripts(blocks).map(script => {
    const scriptBlocks = {};
    script.blocks.forEach(id => defineOwn(scriptBlocks, id, blocks[id]));
    const scriptComments = {};
    Object.keys(comments).sort().forEach(id => {
      if (!script.blocks.includes(comments[id].blockId)) return;
      defineOwn(scriptComments, id, comments[id]);
      claimedComments.add(id);
    });
    const root = blockPosition(blocks[script.root]);
    return {
      id: script.root,
      position: root,
      xml: xmlByRoot.get(script.root) || null,
      blocks: sortValue(scriptBlocks),
      comments: sortValue(scriptComments)
    };
  });
  const workspaceComments = {};
  Object.keys(comments).sort().filter(id => !claimedComments.has(id))
    .forEach(id => defineOwn(workspaceComments, id, comments[id]));
  return {
    target: {
      format: 'nitrobolt-target',
      version: 1,
      target: sortValue(metadata)
    },
    blocks: {
      format: 'nitrobolt-blocks',
      version: 1,
      scripts,
      workspaceComments: sortValue(workspaceComments)
    }
  };
};

const stringifyTargetDocuments = (target, workspaceTarget) => {
  const documents = targetDocuments(target, workspaceTarget);
  return {
    blocks: `${JSON.stringify(documents.blocks, null, 2)}\n`,
    target: `${JSON.stringify(documents.target, null, 2)}\n`
  };
};

const applyBlocksDocument = (target, document) => {
  if (document.format !== 'nitrobolt-blocks' || document.version !== 1 ||
    !Array.isArray(document.scripts) || !document.workspaceComments ||
    typeof document.workspaceComments !== 'object' || Array.isArray(document.workspaceComments)) {
    throw new Error('Unsupported block JSON');
  }
  target.blocks = {};
  target.comments = {...document.workspaceComments};
  for (const script of document.scripts) {
    if (!script || typeof script !== 'object' || !script.blocks || typeof script.blocks !== 'object' ||
      Array.isArray(script.blocks) || !script.comments || typeof script.comments !== 'object' ||
      Array.isArray(script.comments)) throw new Error('Invalid script in block JSON');
    Object.keys(script.blocks).forEach(id => defineOwn(target.blocks, id, script.blocks[id]));
    Object.keys(script.comments).forEach(id => defineOwn(target.comments, id, script.comments[id]));
  }
  target._nitroboltScripts = document.scripts.map(script => ({
    id: script.id,
    position: script.position || {x: 0, y: 0},
    xml: script.xml || null
  }));
  return target;
};

const parseTarget = (source, blocksSource = null) => {
  const document = JSON.parse(source);
  if (document.format !== 'nitrobolt-target' || document.version !== 1 || !document.target ||
    typeof document.target !== 'object' || Array.isArray(document.target)) {
    throw new Error('Unsupported target JSON');
  }
  const target = document.target;
  if (blocksSource === null) throw new Error(`Target JSON requires a sibling ${BLOCKS_FILE}`);
  return applyBlocksDocument(target, JSON.parse(blocksSource));
};

const parseBlocks = source => applyBlocksDocument({}, JSON.parse(source));

const isTargetFilePath = filePath => {
  if (typeof filePath !== 'string' || filePath.includes('\\')) return false;
  const normalized = path.posix.normalize(filePath);
  const parts = normalized.split('/');
  return normalized === filePath && parts.length === 2 && parts[0] !== '.' && parts[0] !== '..' &&
    !RESERVED_TARGET_FOLDERS.has(parts[0].toLowerCase()) && parts[1] === TARGET_FILE;
};

const stringifyManifest = (project, targetFiles) => {
  const metadata = {...project};
  delete metadata.targets;
  return `${JSON.stringify({
    format: 'nitrobolt-project',
    version: 1,
    metadata: sortValue(metadata),
    targets: targetFiles
  }, null, 2)}\n`;
};

const parseManifest = source => {
  const document = JSON.parse(source);
  if (document.format !== 'nitrobolt-project' || document.version !== 1 || !document.metadata ||
    typeof document.metadata !== 'object' || Array.isArray(document.metadata) ||
    !Array.isArray(document.targets)) throw new Error('Unsupported project JSON');
  document.targets.forEach(filePath => {
    if (!isTargetFilePath(filePath)) throw new Error(`Invalid target path in manifest: ${filePath}`);
  });
  if (new Set(document.targets.map(filePath => filePath.toLowerCase())).size !== document.targets.length) {
    throw new Error('Manifest contains duplicate target paths');
  }
  return {metadata: document.metadata, targetFiles: document.targets};
};

const targetFolderBase = (target, index) => {
  const fallback = target.isStage ? 'Stage' : `Sprite ${index}`;
  let name = String(target.name || fallback)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  if (RESERVED_TARGET_FOLDERS.has(name.toLowerCase())) name = `_${name}`;
  return name.substring(0, 80).replace(/[. ]+$/g, '') || fallback;
};

const targetFilePaths = targets => {
  const used = new Set();
  return targets.map((target, index) => {
    const base = targetFolderBase(target, index);
    let folder = base;
    let suffix = 2;
    while (used.has(folder.toLowerCase())) folder = `${base} ${suffix++}`;
    used.add(folder.toLowerCase());
    return `${folder}/${TARGET_FILE}`;
  });
};

const safeAssetFilename = (asset, index, used) => {
  const extension = String(asset.dataFormat || path.extname(asset.md5ext || '').substring(1) || 'bin')
    .replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const fallback = `Asset ${index + 1}`;
  let base = String(asset.name || fallback)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(new RegExp(`\\.${extension}$`, 'i'), '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim() || fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  base = base.substring(0, 100).replace(/[. ]+$/g, '') || fallback;
  let filename = `${base}.${extension}`;
  let suffix = 2;
  while (used.has(filename.toLowerCase())) filename = `${base} ${suffix++}.${extension}`;
  used.add(filename.toLowerCase());
  return filename;
};

const prepareTarget = (target, targetFile, zip) => {
  const serialized = JSON.parse(JSON.stringify(target));
  const used = new Set();
  const assets = [];
  const targetFolder = path.posix.dirname(targetFile);
  const prepareList = list => (list || []).forEach((asset, index) => {
    const archiveName = asset.md5ext || (asset.assetId && asset.dataFormat ?
      `${asset.assetId}.${asset.dataFormat}` : null);
    if (!archiveName || archiveName.includes('/') || archiveName.includes('\\')) {
      throw new Error(`Target asset does not have a valid serialized name: ${asset.name || index}`);
    }
    const entry = zip.getEntry(archiveName);
    if (!entry || entry.isDirectory) throw new Error(`Project archive does not contain asset ${archiveName}`);
    const filename = safeAssetFilename(asset, index, used);
    asset.file = `${ASSET_DIRECTORY}/${filename}`;
    delete asset.assetId;
    delete asset.md5ext;
    assets.push({
      data: entry.getData(),
      filePath: `${targetFolder}/${ASSET_DIRECTORY}/${filename}`,
      reference: asset,
      relativeTo: targetFolder
    });
  });
  prepareList(serialized.costumes);
  prepareList(serialized.sounds);
  prepareList(serialized.assets);
  return {assets, target: serialized};
};

const prepareProjectMetadata = (project, zip) => {
  const metadata = JSON.parse(JSON.stringify(project));
  delete metadata.targets;
  const assets = [];
  const used = new Set();
  (metadata.customFonts || []).forEach((font, index) => {
    if (font.system || !font.md5ext) return;
    const entry = zip.getEntry(font.md5ext);
    if (!entry || entry.isDirectory) throw new Error(`Project archive does not contain font ${font.md5ext}`);
    const extension = path.extname(font.md5ext).substring(1) || 'bin';
    const filename = safeAssetFilename({
      dataFormat: extension,
      name: font.family || `Font ${index + 1}`
    }, index, used);
    font.file = `${ASSET_DIRECTORY}/${filename}`;
    delete font.md5ext;
    assets.push({data: entry.getData(), filePath: font.file, reference: font, relativeTo: ''});
  });
  return {assets, metadata};
};

const assetPathsForDefinition = definition => {
  if (!definition) return [];
  const result = [];
  definition.project.targets.forEach((target, index) => {
    const folder = path.posix.dirname(definition.targetFiles[index]);
    [...(target.costumes || []), ...(target.sounds || []), ...(target.assets || [])].forEach(asset => {
      if (typeof asset.file === 'string' && /^assets\/[^/\\]+$/.test(asset.file)) {
        result.push(`${folder}/${asset.file}`);
      }
    });
  });
  (definition.project.customFonts || []).forEach(font => {
    if (typeof font.file === 'string' && /^assets\/[^/\\]+$/.test(font.file)) result.push(font.file);
  });
  return result;
};

const hydrateTargetAssets = async (repository, target, targetFile, zip) => {
  const hydrated = JSON.parse(JSON.stringify(target));
  delete hydrated._nitroboltScripts;
  const folder = path.posix.dirname(targetFile);
  const hydrateList = async list => {
    for (const asset of list || []) {
      if (!asset.file) continue;
      if (!/^assets\/[^/\\]+$/.test(asset.file)) throw new Error(`Invalid target asset path: ${asset.file}`);
      const assetPath = path.posix.join(folder, asset.file);
      const data = await fsPromises.readFile(await assertManagedPath(repository, assetPath));
      const extension = String(asset.dataFormat || path.posix.extname(asset.file).substring(1) || 'bin');
      const assetId = crypto.createHash('md5').update(data).digest('hex');
      asset.assetId = assetId;
      asset.md5ext = `${assetId}.${extension}`;
      delete asset.file;
      if (!zip.getEntry(asset.md5ext)) zip.addFile(asset.md5ext, data);
    }
  };
  await hydrateList(hydrated.costumes);
  await hydrateList(hydrated.sounds);
  await hydrateList(hydrated.assets);
  return hydrated;
};

const hydrateProjectMetadata = async (repository, project, zip) => {
  const hydrated = JSON.parse(JSON.stringify(project));
  delete hydrated.targets;
  for (const font of hydrated.customFonts || []) {
    if (font.system || !font.file) continue;
    if (!/^assets\/[^/\\]+$/.test(font.file)) throw new Error(`Invalid font asset path: ${font.file}`);
    const data = await fsPromises.readFile(await assertManagedPath(repository, font.file));
    const extension = path.extname(font.file).substring(1) || 'bin';
    const assetId = crypto.createHash('md5').update(data).digest('hex');
    font.md5ext = `${assetId}.${extension}`;
    delete font.file;
    if (!zip.getEntry(font.md5ext)) zip.addFile(font.md5ext, data);
  }
  return hydrated;
};

const readProjectDefinition = async repository => {
  try {
    const manifestPath = await assertManagedPath(repository, PROJECT_FILE);
    const manifestSource = await fsPromises.readFile(manifestPath, 'utf8');
    const manifest = parseManifest(manifestSource);
    const targets = [];
    const blockFiles = [];
    for (const targetFile of manifest.targetFiles) {
      const targetSource = await fsPromises.readFile(await assertManagedPath(repository, targetFile), 'utf8');
      const blockFile = path.posix.join(path.posix.dirname(targetFile), BLOCKS_FILE);
      const blocksSource = await fsPromises.readFile(await assertManagedPath(repository, blockFile), 'utf8');
      blockFiles.push(blockFile);
      targets.push(parseTarget(targetSource, blocksSource));
    }
    return {
      project: {...manifest.metadata, targets},
      blockFiles,
      targetFiles: manifest.targetFiles
    };
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === path.join(repository, PROJECT_FILE)) return null;
    throw error;
  }
};

const ensureGitAttributes = async repository => {
  const attributesPath = await assertManagedPath(repository, '.gitattributes');
  let contents = '';
  try {
    contents = await fsPromises.readFile(attributesPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const required = [
    `${PROJECT_FILE} text eol=lf`,
    `*/${TARGET_FILE} text eol=lf`,
    `*/${BLOCKS_FILE} text eol=lf`,
    ...[...BINARY_ASSET_EXTENSIONS].map(extension => `*/${ASSET_DIRECTORY}/*${extension} binary`),
    `${ASSET_DIRECTORY}/* binary`
  ];
  const lines = contents ? contents.split(/\r?\n/) : [];
  required.forEach(line => {
    if (!lines.includes(line)) lines.push(line);
  });
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const nextContents = `${lines.join('\n')}\n`;
  if (nextContents !== contents) await fsPromises.writeFile(attributesPath, nextContents);
};

const replaceFiles = async entries => {
  const timestamp = Date.now();
  const replacements = [];
  try {
    for (let index = 0; index < entries.length; index++) {
      const {temporaryPath, destinationPath} = entries[index];
      const replacement = {
        backupPath: `${destinationPath}.backup-${process.pid}-${timestamp}-${index}`,
        destinationPath,
        hadExistingFile: false,
        installedNewFile: false
      };
      replacements.push(replacement);
      try {
        await fsPromises.rename(destinationPath, replacement.backupPath);
        replacement.hadExistingFile = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fsPromises.rename(temporaryPath, destinationPath);
      replacement.installedNewFile = true;
    }
  } catch (error) {
    for (const replacement of replacements.reverse()) {
      if (replacement.installedNewFile) {
        await fsPromises.rm(replacement.destinationPath, {force: true}).catch(restoreError => {
          error.message += ` (also failed to remove a partial project file: ${restoreError.message})`;
        });
      }
      if (!replacement.hadExistingFile) continue;
      try {
        await fsPromises.rename(replacement.backupPath, replacement.destinationPath);
      } catch (restoreError) {
        error.message += ` (also failed to restore a previous project file: ${restoreError.message})`;
      }
    }
    throw error;
  }
  for (const replacement of replacements) {
    if (replacement.hadExistingFile) {
      // Installation has succeeded. A leftover backup is safer than rolling
      // the new project back just because cleanup was interrupted.
      await fsPromises.rm(replacement.backupPath, {force: true}).catch(() => {});
    }
  }
};

const syncProject = async (repoPath, archive, workspaceXML = []) => {
  const repository = await assertRepository(repoPath);
  const zip = new AdmZip(Buffer.from(archive));
  const project = getProjectJSON(zip);
  let oldDefinition;
  try {
    oldDefinition = await readProjectDefinition(repository);
  } catch (error) {
    throw new Error(`Existing project cannot be read safely: ${error.message}`);
  }
  const oldAssets = assetPathsForDefinition(oldDefinition);
  const oldTargetFiles = oldDefinition ? oldDefinition.targetFiles : [];
  const oldBlockFiles = oldDefinition ? oldDefinition.blockFiles : [];
  const oldTargetPaths = new Map(oldTargetFiles.map(filePath => [filePath.toLowerCase(), filePath]));
  const targetFiles = targetFilePaths(project.targets || [])
    .map(filePath => oldTargetPaths.get(filePath.toLowerCase()) || filePath);
  const saveId = `${process.pid}-${Date.now()}`;
  const projectPath = path.join(repository, PROJECT_FILE);
  const temporaryPath = `${projectPath}.tmp-${saveId}`;
  const preparedProject = prepareProjectMetadata(project, zip);
  const targetEntries = targetFiles.map((targetFile, index) => {
    const file = path.join(repository, ...targetFile.split('/'));
    const blocksFile = path.join(path.dirname(file), BLOCKS_FILE);
    const prepared = prepareTarget(project.targets[index], targetFile, zip);
    const serializedTarget = project.targets[index];
    const workspaceTarget = serializedTarget.id ?
      workspaceXML.find(target => target.id === serializedTarget.id) : workspaceXML[index];
    if (!workspaceTarget || Boolean(workspaceTarget.isStage) !== Boolean(serializedTarget.isStage) ||
      workspaceTarget.name !== serializedTarget.name) {
      throw new Error(`Could not match workspace XML to target ${serializedTarget.name || index}`);
    }
    return {
      assets: prepared.assets,
      blocksFile,
      blocksTemporaryFile: `${blocksFile}.tmp-${saveId}-${index}`,
      file,
      preparedTarget: prepared.target,
      targetFile,
      temporaryFile: `${file}.tmp-${saveId}-${index}`,
      workspaceTarget
    };
  });
  const assetEntries = [...targetEntries.flatMap(entry => entry.assets), ...preparedProject.assets];
  const oldAssetPaths = new Map(oldAssets.map(filePath => [filePath.toLowerCase(), filePath]));
  assetEntries.forEach((entry, index) => {
    const oldPath = oldAssetPaths.get(entry.filePath.toLowerCase());
    if (oldPath) {
      entry.filePath = oldPath;
      entry.reference.file = entry.relativeTo ? path.posix.relative(entry.relativeTo, oldPath) : oldPath;
    }
    entry.file = path.join(repository, ...entry.filePath.split('/'));
    entry.temporaryFile = `${entry.file}.tmp-${saveId}-${index}`;
  });
  for (const entry of targetEntries) {
    const documents = stringifyTargetDocuments(entry.preparedTarget, entry.workspaceTarget);
    entry.blocksSource = documents.blocks;
    entry.source = documents.target;
  }
  const managedPaths = new Set([
    PROJECT_FILE,
    '.gitattributes',
    ...targetFiles,
    ...targetFiles.map(filePath => path.posix.join(path.posix.dirname(filePath), BLOCKS_FILE)),
    ...assetEntries.map(entry => entry.filePath),
    ...oldTargetFiles,
    ...oldBlockFiles,
    ...oldAssets
  ]);
  await Promise.all([...managedPaths].map(filePath => assertManagedPath(repository, filePath)));
  const oldAssetSet = new Set(oldAssets.map(filePath => filePath.toLowerCase()));
  const oldTargetSet = new Set(oldTargetFiles.map(filePath => filePath.toLowerCase()));

  for (const entry of targetEntries) {
    if (oldTargetSet.has(entry.targetFile.toLowerCase())) continue;
    try {
      await fsPromises.access(entry.file);
      throw new Error(`Refusing to overwrite an unmanaged target file: ${entry.targetFile}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const oldBlockSet = new Set(oldBlockFiles.map(filePath => filePath.toLowerCase()));
  for (const entry of targetEntries) {
    const relative = path.relative(repository, entry.blocksFile).replace(/\\/g, '/');
    if (oldBlockSet.has(relative.toLowerCase())) continue;
    try {
      await fsPromises.access(entry.blocksFile);
      throw new Error(`Refusing to overwrite an unmanaged blocks file: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const entry of assetEntries) {
    if (oldAssetSet.has(entry.filePath.toLowerCase())) continue;
    const file = path.join(repository, ...entry.filePath.split('/'));
    try {
      await fsPromises.access(file);
      throw new Error(`Refusing to overwrite an unmanaged target asset: ${entry.filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  try {
    for (const entry of targetEntries) {
      await fsPromises.mkdir(path.dirname(entry.file), {recursive: true});
      await fsPromises.writeFile(entry.temporaryFile, entry.source);
      await fsPromises.writeFile(entry.blocksTemporaryFile, entry.blocksSource);
    }
    await fsPromises.writeFile(temporaryPath, stringifyManifest(preparedProject.metadata, targetFiles));
    for (const entry of assetEntries) {
      await fsPromises.mkdir(path.dirname(entry.file), {recursive: true});
      await fsPromises.writeFile(entry.temporaryFile, entry.data);
    }
    await ensureGitAttributes(repository);
    await replaceFiles([
      ...targetEntries.flatMap(entry => [
        {temporaryPath: entry.temporaryFile, destinationPath: entry.file},
        {temporaryPath: entry.blocksTemporaryFile, destinationPath: entry.blocksFile}
      ]),
      ...assetEntries.map(entry => ({temporaryPath: entry.temporaryFile, destinationPath: entry.file})),
      {temporaryPath, destinationPath: projectPath}
    ]);
    const assets = assetEntries.map(entry => entry.filePath);
    const blockFiles = targetFiles.map(filePath => path.posix.join(path.posix.dirname(filePath), BLOCKS_FILE));
    const assetSet = new Set(assets.map(filePath => filePath.toLowerCase()));
    const targetSet = new Set(targetFiles.map(filePath => filePath.toLowerCase()));
    const blockSet = new Set(blockFiles.map(filePath => filePath.toLowerCase()));
    const staleAssets = oldAssets.filter(filePath => !assetSet.has(filePath.toLowerCase()));
    const staleTargets = oldTargetFiles.filter(filePath => !targetSet.has(filePath.toLowerCase()));
    const staleBlocks = oldBlockFiles.filter(filePath => !blockSet.has(filePath.toLowerCase()));
    for (const assetName of staleAssets) {
      // Stale files do not affect the new project. Cleanup is best-effort so a
      // temporary file lock cannot make a successful project save appear lost.
      await fsPromises.rm(path.join(repository, ...assetName.split('/')), {force: true}).catch(() => {});
    }
    for (const staleTarget of staleTargets) {
      await fsPromises.rm(path.join(repository, ...staleTarget.split('/')), {force: true}).catch(() => {});
    }
    for (const staleBlock of staleBlocks) {
      await fsPromises.rm(path.join(repository, ...staleBlock.split('/')), {force: true}).catch(() => {});
    }
    const staleFolders = new Set([...staleTargets, ...staleBlocks].map(filePath => path.posix.dirname(filePath)));
    for (const staleFolder of staleFolders) {
      const folder = path.join(repository, ...staleFolder.split('/'));
      await fsPromises.rmdir(path.join(folder, ASSET_DIRECTORY)).catch(() => {});
      await fsPromises.rmdir(folder).catch(() => {});
    }
  } catch (error) {
    await fsPromises.rm(temporaryPath, {force: true});
    for (const entry of targetEntries) {
      await fsPromises.rm(entry.temporaryFile, {force: true}).catch(() => {});
      await fsPromises.rm(entry.blocksTemporaryFile, {force: true}).catch(() => {});
    }
    for (const entry of assetEntries) {
      await fsPromises.rm(entry.temporaryFile, {force: true}).catch(() => {});
    }
    throw error;
  }
};

const readProject = async repoPath => {
  const repository = await assertRepository(repoPath);
  const definition = await readProjectDefinition(repository);
  if (!definition) throw new Error(`Folder does not contain ${PROJECT_FILE}`);
  const zip = new AdmZip();
  const metadata = await hydrateProjectMetadata(repository, definition.project, zip);
  const targets = [];
  for (let index = 0; index < definition.project.targets.length; index++) {
    targets.push(await hydrateTargetAssets(
      repository,
      definition.project.targets[index],
      definition.targetFiles[index],
      zip
    ));
  }
  const project = {...metadata, targets};
  zip.addFile(PROJECT_FILE, Buffer.from(JSON.stringify(project)));
  return zip.toBuffer();
};

module.exports = {
  BINARY_ASSET_EXTENSIONS,
  BLOCKS_FILE,
  parseBlocks,
  readProject,
  syncProject
};
