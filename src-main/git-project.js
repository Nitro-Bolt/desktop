const AdmZip = require('adm-zip');
const crypto = require('crypto');
const fsPromises = require('fs/promises');
const path = require('path');

const PROJECT_FILE = 'project.json';
const TARGET_FILE = 'target.json';
const BLOCKS_FILE = 'blocks.json';
const TARGET_DIRECTORY = 'targets';
const ASSET_DIRECTORY = 'assets';
const FORMAT_VERSION = 2;
const repositoryOperations = [];

const defineOwn = (object, key, value) => Object.defineProperty(object, key, {
  configurable: true, enumerable: true, value, writable: true
});
const uniqueStrings = values => values.filter((value, index) => values.indexOf(value) === index);
const sortValue = value => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  Object.keys(value).sort().forEach(key => defineOwn(result, key, sortValue(value[key])));
  return result;
};
const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
const contentId = data => crypto.createHash('sha256').update(data).digest('hex');
const targetDirectory = id => `${TARGET_DIRECTORY}/${contentId(Buffer.from(id)).slice(0, 24)}`;

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
  x: Number(block && block.x) || 0, y: Number(block && block.y) || 0
};

const orderedScripts = blocks => {
  const visited = [];
  const visit = (id, ordered) => {
    if (!id || visited.includes(id) || !blocks[id]) return;
    visited.push(id);
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
    const ids = [];
    visit(root, ids);
    scripts.push({root, ids});
  });
  Object.keys(blocks).sort().forEach(root => {
    if (visited.includes(root)) return;
    const ids = [];
    visit(root, ids);
    scripts.push({root, ids});
  });
  return scripts;
};

const bestPreviousScript = (script, previousScripts, claimedIds) => {
  const available = previousScripts.filter(candidate => !claimedIds.includes(candidate.id));
  const sameRoot = available.find(candidate => candidate.root === script.root);
  if (sameRoot) return sameRoot;
  let best = null;
  let bestOverlap = 0;
  for (const candidate of available) {
    const candidateIds = Object.keys(candidate.blocks || {});
    const overlap = script.ids.filter(id => candidateIds.includes(id)).length;
    if (overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return bestOverlap ? best : null;
};

const createBlocksDocument = (target, previousDocument = null) => {
  const blocks = target.blocks || {};
  const comments = target.comments || {};
  const previousScripts = previousDocument && Array.isArray(previousDocument.scripts) ? previousDocument.scripts : [];
  const claimedScriptIds = [];
  const claimedCommentIds = [];
  const scripts = orderedScripts(blocks).map(script => {
    const previous = bestPreviousScript(script, previousScripts, claimedScriptIds);
    const scriptId = previous ? previous.id : crypto.randomUUID();
    claimedScriptIds.push(scriptId);
    const scriptBlocks = {};
    const scriptComments = {};
    script.ids.forEach(id => defineOwn(scriptBlocks, id, blocks[id]));
    Object.keys(comments).sort().forEach(id => {
      if (!script.ids.includes(comments[id].blockId)) return;
      defineOwn(scriptComments, id, comments[id]);
      claimedCommentIds.push(id);
    });
    return {
      id: scriptId,
      root: script.root,
      blocks: sortValue(scriptBlocks),
      comments: sortValue(scriptComments)
    };
  });
  const workspaceComments = {};
  Object.keys(comments).sort().filter(id => !claimedCommentIds.includes(id))
    .forEach(id => defineOwn(workspaceComments, id, comments[id]));
  return {
    format: 'nitrobolt-blocks', version: FORMAT_VERSION, scripts,
    workspaceComments: sortValue(workspaceComments)
  };
};

const parseBlocksDocument = source => {
  const document = typeof source === 'string' ? JSON.parse(source) : source;
  if (!document || document.format !== 'nitrobolt-blocks' || document.version !== FORMAT_VERSION ||
    !Array.isArray(document.scripts) || !document.workspaceComments ||
    typeof document.workspaceComments !== 'object' || Array.isArray(document.workspaceComments)) {
    throw new Error('Unsupported blocks file. Convert this repository to NitroBolt Git format 2.');
  }
  const scriptIds = [];
  document.scripts.forEach(script => {
    if (!script || typeof script.id !== 'string' || !script.id || scriptIds.includes(script.id) ||
      typeof script.root !== 'string' || !script.blocks || typeof script.blocks !== 'object' ||
      Array.isArray(script.blocks) || !script.blocks[script.root] || !script.comments ||
      typeof script.comments !== 'object' || Array.isArray(script.comments)) throw new Error('Invalid blocks file');
    scriptIds.push(script.id);
  });
  return document;
};

const applyBlocksDocument = (target, document) => {
  const parsed = parseBlocksDocument(document);
  target.blocks = {};
  target.comments = {...parsed.workspaceComments};
  parsed.scripts.forEach(script => {
    Object.keys(script.blocks).forEach(id => {
      if (target.blocks[id]) throw new Error(`Duplicate block ID: ${id}`);
      defineOwn(target.blocks, id, script.blocks[id]);
    });
    Object.keys(script.comments).forEach(id => {
      if (target.comments[id]) throw new Error(`Duplicate comment ID: ${id}`);
      defineOwn(target.comments, id, script.comments[id]);
    });
  });
  target._nitroboltScripts = parsed.scripts.map(script => ({
    id: script.id, root: script.root
  }));
  return target;
};
const parseBlocks = source => applyBlocksDocument({}, source);

const parseTargetDocument = source => {
  const document = typeof source === 'string' ? JSON.parse(source) : source;
  if (!document || document.format !== 'nitrobolt-target' || document.version !== FORMAT_VERSION ||
    !document.target || typeof document.target !== 'object' || Array.isArray(document.target)) {
    throw new Error('Unsupported target file. Convert this repository to NitroBolt Git format 2.');
  }
  return document.target;
};

const parseManifest = source => {
  const document = JSON.parse(source);
  if (document.format !== 'nitrobolt-project' || document.version !== FORMAT_VERSION || !document.metadata ||
    typeof document.metadata !== 'object' || Array.isArray(document.metadata) || !Array.isArray(document.targets)) {
    throw new Error('Unsupported project file. Convert this repository to NitroBolt Git format 2.');
  }
  const ids = [];
  const files = [];
  document.targets.forEach(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.includes(entry.id) ||
      typeof entry.file !== 'string' || files.includes(entry.file.toLowerCase()) ||
      entry.file !== `${targetDirectory(entry.id)}/${TARGET_FILE}`) throw new Error('Invalid project target entry');
    ids.push(entry.id);
    files.push(entry.file.toLowerCase());
  });
  return document;
};

const readProjectDefinition = async repository => {
  const manifestPath = await assertManagedPath(repository, PROJECT_FILE);
  let source;
  try {
    source = await fsPromises.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const manifest = parseManifest(source);
  const targets = [];
  const blocks = [];
  for (const entry of manifest.targets) {
    const targetSource = await fsPromises.readFile(await assertManagedPath(repository, entry.file), 'utf8');
    const blocksFile = path.posix.join(path.posix.dirname(entry.file), BLOCKS_FILE);
    const blocksSource = await fsPromises.readFile(await assertManagedPath(repository, blocksFile), 'utf8');
    const target = parseTargetDocument(targetSource);
    if (target.id !== entry.id) throw new Error(`Target ID does not match manifest: ${entry.id}`);
    const blocksDocument = parseBlocksDocument(blocksSource);
    targets.push(applyBlocksDocument(target, blocksDocument));
    blocks.push(blocksDocument);
  }
  return {manifest, project: {...manifest.metadata, targets}, blocks};
};

const assetExtension = asset => String(asset.dataFormat || path.extname(asset.md5ext || asset.file || '').slice(1) || 'bin')
  .replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
const snapshotAsset = (files, archiveName) => {
  if (!archiveName || archiveName.includes('/') || archiveName.includes('\\') || !files[archiveName]) {
    throw new Error(`Project snapshot does not contain asset ${archiveName || ''}`);
  }
  return Buffer.from(files[archiveName]);
};
const prepareAsset = (asset, files) => {
  const archiveName = asset.md5ext || (asset.assetId && asset.dataFormat ? `${asset.assetId}.${asset.dataFormat}` : null);
  const data = snapshotAsset(files, archiveName);
  const filePath = `${ASSET_DIRECTORY}/${contentId(data)}.${assetExtension(asset)}`;
  asset.file = filePath;
  delete asset.assetId;
  delete asset.md5ext;
  return {data, filePath};
};

const prepareProject = (project, files, previousDefinition) => {
  if (!Array.isArray(project.targets)) throw new Error('Project snapshot does not contain a target list');
  const metadata = JSON.parse(JSON.stringify(project));
  delete metadata.targets;
  const assetEntries = [];
  const addAsset = entry => {
    if (!assetEntries.some(candidate => candidate.filePath === entry.filePath)) assetEntries.push(entry);
  };
  (metadata.customFonts || []).forEach(font => {
    if (!font.system && font.md5ext) addAsset(prepareAsset(font, files));
  });
  const targetIds = [];
  const targets = project.targets.map(targetSource => {
    const target = JSON.parse(JSON.stringify(targetSource));
    if (typeof target.id !== 'string' || !target.id || targetIds.includes(target.id)) {
      throw new Error('Git snapshots require unique, stable target IDs');
    }
    targetIds.push(target.id);
    const previousIndex = previousDefinition ?
      previousDefinition.manifest.targets.findIndex(entry => entry.id === target.id) : -1;
    const previousBlocks = previousIndex >= 0 ? previousDefinition.blocks[previousIndex] : null;
    const blocks = createBlocksDocument(target, previousBlocks);
    delete target.blocks;
    delete target.comments;
    [...(target.costumes || []), ...(target.sounds || []), ...(target.assets || [])]
      .forEach(asset => addAsset(prepareAsset(asset, files)));
    return {blocks, target: sortValue(target)};
  });
  return {assetEntries, metadata: sortValue(metadata), targets};
};

const hydrateAssets = async (repository, value, zip) => {
  for (const asset of value || []) {
    if (asset.system) continue;
    if (!asset.file || !/^assets\/[0-9a-f]{64}\.[a-z0-9]+$/.test(asset.file)) {
      throw new Error(`Invalid asset path: ${asset.file || ''}`);
    }
    const data = await fsPromises.readFile(await assertManagedPath(repository, asset.file));
    const extension = assetExtension(asset);
    const assetId = crypto.createHash('md5').update(data).digest('hex');
    asset.assetId = assetId;
    asset.md5ext = `${assetId}.${extension}`;
    delete asset.file;
    if (!zip.getEntry(asset.md5ext)) zip.addFile(asset.md5ext, data);
  }
};

const managedFiles = definition => {
  if (!definition) return [];
  const result = [PROJECT_FILE];
  definition.manifest.targets.forEach(entry => {
    result.push(entry.file, path.posix.join(path.posix.dirname(entry.file), BLOCKS_FILE));
  });
  const collect = value => (value || []).forEach(asset => {
    if (typeof asset.file === 'string') result.push(asset.file);
  });
  definition.project.targets.forEach(target => {
    collect(target.costumes);
    collect(target.sounds);
    collect(target.assets);
  });
  collect(definition.project.customFonts);
  return uniqueStrings(result);
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
    `${PROJECT_FILE} text eol=lf`, `${TARGET_DIRECTORY}/**/${TARGET_FILE} text eol=lf`,
    `${TARGET_DIRECTORY}/**/${BLOCKS_FILE} text eol=lf`, `${ASSET_DIRECTORY}/** binary`
  ];
  const lines = contents ? contents.split(/\r?\n/) : [];
  required.forEach(line => {
    if (!lines.includes(line)) lines.push(line);
  });
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const next = `${lines.join('\n')}\n`;
  if (next !== contents) await fsPromises.writeFile(attributesPath, next);
};

const replaceFiles = async entries => {
  const transaction = `${process.pid}-${Date.now()}`;
  const replacements = [];
  try {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const replacement = {
        ...entry, backupPath: `${entry.destinationPath}.backup-${transaction}-${index}`,
        existed: false, installed: false
      };
      replacements.push(replacement);
      try {
        await fsPromises.rename(entry.destinationPath, replacement.backupPath);
        replacement.existed = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fsPromises.rename(entry.temporaryPath, entry.destinationPath);
      replacement.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const replacement of replacements.reverse()) {
      if (replacement.installed) await fsPromises.rm(replacement.destinationPath, {force: true})
        .catch(rollbackError => rollbackErrors.push(rollbackError.message));
      if (replacement.existed) await fsPromises.rename(replacement.backupPath, replacement.destinationPath)
        .catch(rollbackError => rollbackErrors.push(rollbackError.message));
    }
    if (rollbackErrors.length) error.message += ` Rollback also failed: ${rollbackErrors.join('; ')}`;
    throw error;
  }
  await Promise.all(replacements.filter(entry => entry.existed)
    .map(entry => fsPromises.rm(entry.backupPath, {force: true}).catch(() => {})));
};

const writeProject = async (repository, files) => {
  if (!files || typeof files !== 'object' || !files[PROJECT_FILE]) throw new Error('Invalid project snapshot');
  const project = JSON.parse(Buffer.from(files[PROJECT_FILE]).toString('utf8'));
  const previous = await readProjectDefinition(repository);
  const prepared = prepareProject(project, files, previous);
  const targets = project.targets.map(target => ({
    id: target.id, file: `${targetDirectory(target.id)}/${TARGET_FILE}`
  }));
  const manifest = {
    format: 'nitrobolt-project', version: FORMAT_VERSION, metadata: prepared.metadata, targets
  };
  const saveId = `${process.pid}-${Date.now()}`;
  const writes = [];
  const previousFiles = managedFiles(previous).map(filePath => filePath.toLowerCase());
  const addWrite = async (filePath, data) => {
    const destinationPath = await assertManagedPath(repository, filePath);
    if (!previousFiles.includes(filePath.toLowerCase())) {
      try {
        await fsPromises.access(destinationPath);
        throw new Error(`Refusing to overwrite an unmanaged project file: ${filePath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const temporaryPath = `${destinationPath}.tmp-${saveId}-${writes.length}`;
    await fsPromises.mkdir(path.dirname(destinationPath), {recursive: true});
    await fsPromises.writeFile(temporaryPath, data);
    writes.push({destinationPath, temporaryPath});
  };
  try {
    for (let index = 0; index < targets.length; index++) {
      const targetPath = targets[index].file;
      const folder = path.posix.dirname(targetPath);
      await addWrite(targetPath, stringify({
        format: 'nitrobolt-target', version: FORMAT_VERSION, target: prepared.targets[index].target
      }));
      await addWrite(`${folder}/${BLOCKS_FILE}`, stringify(prepared.targets[index].blocks));
    }
    for (const asset of prepared.assetEntries) await addWrite(asset.filePath, asset.data);
    await addWrite(PROJECT_FILE, stringify(manifest));
    await ensureGitAttributes(repository);
    await replaceFiles(writes);
  } catch (error) {
    await Promise.all(writes.map(entry => fsPromises.rm(entry.temporaryPath, {force: true}).catch(() => {})));
    throw error;
  }
  const nextFiles = [PROJECT_FILE, ...targets.flatMap(entry => [
    entry.file, `${path.posix.dirname(entry.file)}/${BLOCKS_FILE}`
  ]), ...prepared.assetEntries.map(entry => entry.filePath)];
  const staleFiles = managedFiles(previous).filter(filePath => !nextFiles.includes(filePath));
  for (const filePath of staleFiles) {
    await fsPromises.rm(await assertManagedPath(repository, filePath), {force: true}).catch(() => {});
  }
};

const loadProject = async repository => {
  const definition = await readProjectDefinition(repository);
  if (!definition) throw new Error(`Folder does not contain ${PROJECT_FILE}`);
  const zip = new AdmZip();
  const metadata = JSON.parse(JSON.stringify(definition.manifest.metadata));
  await hydrateAssets(repository, metadata.customFonts, zip);
  const targets = [];
  for (const targetSource of definition.project.targets) {
    const target = JSON.parse(JSON.stringify(targetSource));
    delete target._nitroboltScripts;
    await hydrateAssets(repository, target.costumes, zip);
    await hydrateAssets(repository, target.sounds, zip);
    await hydrateAssets(repository, target.assets, zip);
    targets.push(target);
  }
  zip.addFile(PROJECT_FILE, Buffer.from(JSON.stringify({...metadata, targets})));
  return zip.toBuffer();
};

const withRepositoryOperation = async (repoPath, operation) => {
  const repository = await assertRepository(repoPath);
  let queue = repositoryOperations.find(entry => entry.repository === repository);
  if (!queue) {
    queue = {repository, promise: Promise.resolve()};
    repositoryOperations.push(queue);
  }
  const promise = queue.promise.catch(() => {}).then(() => operation(repository));
  queue.promise = promise;
  try {
    return await promise;
  } finally {
    if (queue.promise === promise) repositoryOperations.splice(repositoryOperations.indexOf(queue), 1);
  }
};

const syncProject = (repoPath, files) => withRepositoryOperation(repoPath, repository =>
  writeProject(repository, files));
const readProject = repoPath => withRepositoryOperation(repoPath, loadProject);

module.exports = {BLOCKS_FILE, parseBlocks, readProject, syncProject};
