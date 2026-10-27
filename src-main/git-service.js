const {spawn} = require('child_process');
const fs = require('fs');
const fsPromises = fs.promises;
const os = require('os');
const path = require('path');
const gitProject = require('./git-project');

const UNMERGED_STATUSES = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
const SAFE_GIT_CONFIG = [
  ['core.hooksPath', os.devNull],
  ['core.fsmonitor', 'false'],
  ['core.pager', 'cat'],
  ['commit.gpgSign', 'false'],
  ['log.showSignature', 'false'],
  ['credential.helper', ''],
  ['protocol.allow', 'never'],
  ['protocol.http.allow', 'always'],
  ['protocol.https.allow', 'always'],
  ['protocol.ext.allow', 'never'],
  ['protocol.file.allow', 'never'],
  ['submodule.recurse', 'false']
];

const displayStatus = gitStatus => {
  if (gitStatus === '?' || gitStatus === 'A') return 'U';
  if (gitStatus === 'D') return 'D';
  return 'M';
};

const projectDiffKind = filePath => {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const extension = path.posix.extname(normalized);
  const filename = path.posix.basename(normalized);
  if (filename === gitProject.BLOCKS_FILE) return 'blocks';
  if (gitProject.BINARY_ASSET_EXTENSIONS.includes(extension)) return 'asset';
  return 'text';
};

const parseBlocksRevision = (source, label) => {
  if (source === null) return null;
  try {
    return {targets: [gitProject.parseBlocks(source)]};
  } catch (error) {
    throw new Error(`Unable to parse ${label} project snapshot: ${error.message}`);
  }
};

const isOutsidePath = (parentPath, childPath) => {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
};

const resolveGitPath = (repository, filePath, label = 'file') => {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\\')) {
    throw new Error(`Invalid ${label} path`);
  }
  const normalized = path.posix.normalize(filePath);
  if (normalized !== filePath || path.posix.isAbsolute(normalized)) throw new Error(`Invalid ${label} path`);
  const fullPath = path.resolve(repository, ...normalized.split('/'));
  if (isOutsidePath(repository, fullPath)) throw new Error(`Invalid ${label} path`);
  return {filePath: normalized, fullPath};
};

const rejectSymbolicPathComponents = async (repository, filePath) => {
  const parts = filePath.split('/');
  let currentPath = repository;
  for (const part of parts.slice(0, -1)) {
    currentPath = path.join(currentPath, part);
    let stat;
    try {
      stat = await fsPromises.lstat(currentPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Refusing to discard through a symbolic link');
    }
  }
};

const rejectSymbolicLink = async filePath => {
  try {
    if ((await fsPromises.lstat(filePath)).isSymbolicLink()) {
      throw new Error(`Refusing to access a symbolic link: ${path.basename(filePath)}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

const readWorkingTreeFile = async (repositoryRoot, fullPath) => {
  try {
    const stat = await fsPromises.lstat(fullPath);
    if (stat.isSymbolicLink()) return await fsPromises.readlink(fullPath, 'utf8');
    const [realRepositoryRoot, realFullPath] = await Promise.all([
      fsPromises.realpath(repositoryRoot),
      fsPromises.realpath(fullPath)
    ]);
    if (isOutsidePath(realRepositoryRoot, realFullPath)) {
      throw new Error('Project diff path resolves outside the repository');
    }
    return await fsPromises.readFile(realFullPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

class GitService {
  constructor() {
    this.gitAvailable = null;
  }

  /**
   * Check if git is installed and available
   * @returns {Promise<boolean>}
   */
  async isGitAvailable() {
    if (this.gitAvailable !== null) {
      return this.gitAvailable;
    }

    try {
      await this.execGit(['--version']);
      this.gitAvailable = true;
      return true;
    } catch (error) {
      this.gitAvailable = false;
      return false;
    }
  }

  /**
   * Execute a git command
   * @param {string[]} args - Git command arguments
   * @param {string} cwd - Working directory
   * @param {Object} outputOptions - Output formatting options
   * @returns {Promise<string>} - Command output
   */
  execGit(args, cwd = null, outputOptions = {}) {
    const {trim = true} = outputOptions;
    return new Promise((resolve, reject) => {
      const env = {...process.env};
      env.GIT_TERMINAL_PROMPT = '0';
      env.GIT_ASKPASS = '';
      if (cwd) {
        try {
          if (fs.lstatSync(path.join(cwd, '.git')).isDirectory()) {
            env.GIT_WORK_TREE = path.resolve(cwd);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      env.GIT_CONFIG_COUNT = String(SAFE_GIT_CONFIG.length);
      SAFE_GIT_CONFIG.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
      });
      const options = {env};
      if (cwd) {
        options.cwd = cwd;
      }

      const git = spawn('git', args, options);
      let stdout = '';
      let stderr = '';

      git.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      git.on('close', (code) => {
        if (code === 0) {
          resolve(trim ? stdout.trim() : stdout);
        } else {
          reject(new Error(stderr || `Git command failed with code ${code}`));
        }
      });

      git.on('error', (error) => {
        reject(error);
      });
    });
  }

  async resolveRepository(repoPath) {
    const selectedPath = await fsPromises.realpath(path.resolve(repoPath));
    let repository = selectedPath;
    while (true) {
      const gitPath = path.join(repository, '.git');
      try {
        const stat = await fsPromises.lstat(gitPath);
        if (!stat.isDirectory()) {
          throw new Error('Git worktrees and symbolic .git paths are not supported');
        }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(repository);
      if (parent === repository) throw new Error('Not a Git repository');
      repository = parent;
    }
    await this.assertNoExecutableConfig(repository);
    return repository;
  }

  async assertNoExecutableConfig(repository) {
    const executableConfig = await this.execGit([
      'config', '--local', '--includes', '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$'
    ], repository).catch(error => {
      if (/exited with code 1|failed with code 1/i.test(error.message)) return '';
      throw error;
    });
    if (executableConfig) {
      throw new Error('This repository contains executable Git filter or merge-driver configuration');
    }
  }

  /**
   * Get git repository status
   * @param {string} repoPath - Path to repository
   * @returns {Promise<Object>}
   */
  async status(repoPath) {
    try {
      const repository = await this.resolveRepository(repoPath);
      const statusOutput = await this.execGit(
        ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--renames'],
        repository,
        {trim: false}
      );
      let commit = null;
      try {
        commit = await this.execGit(['rev-parse', '--short', 'HEAD'], repository);
      } catch (err) {
        // An initialized repository does not have a HEAD commit yet.
      }

      // The NUL-delimited porcelain format leaves paths unquoted, including paths
      // containing spaces or newlines. Rename/copy entries consume a second record
      // containing their original path.
      const records = statusOutput.split('\0');
      let branch = '';
      const staged = [];
      const unstaged = [];
      const untracked = [];
      const conflicted = [];

      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) continue;

        if (record.startsWith('## ')) {
          // Branch line (format: "## branch...tracking" or just "## branch")
          const branchLine = record.substring(3);
          const unbornBranch = branchLine.match(/^(?:No commits yet|Initial commit) on (.+)$/);
          if (unbornBranch) {
            branch = unbornBranch[1];
          } else {
            const branchEnd = branchLine.indexOf('...');
            branch = branchEnd !== -1 ? branchLine.substring(0, branchEnd) : branchLine;
          }
        } else {
          const statusCode = record.substring(0, 2);
          const filename = record.substring(3);

          const stagedStatus = statusCode[0]; // First char is staged
          const unstagedStatus = statusCode[1]; // Second char is unstaged
          const isRenameOrCopy = stagedStatus === 'R' || stagedStatus === 'C' ||
            unstagedStatus === 'R' || unstagedStatus === 'C';
          const originalPath = isRenameOrCopy ? records[++index] || null : null;
          const createChange = gitStatus => ({
            path: filename,
            originalPath: gitStatus === 'R' || gitStatus === 'C' ? originalPath : null,
            status: displayStatus(gitStatus),
            gitStatus,
            diffKind: projectDiffKind(filename)
          });

          // ? = untracked, ! = ignored
          if (stagedStatus === '?' && unstagedStatus === '?') {
            untracked.push(createChange('?'));
          } else if (UNMERGED_STATUSES.includes(statusCode)) {
            conflicted.push({
              ...createChange(statusCode),
              status: '!'
            });
          } else {
            // Add to staged if first char is not space
            if (stagedStatus !== ' ' && stagedStatus !== '?') {
              staged.push(createChange(stagedStatus));
            }
            // Add to unstaged if second char is not space
            if (unstagedStatus !== ' ' && unstagedStatus !== '?') {
              unstaged.push(createChange(unstagedStatus));
            }
          }
        }
      }

      return {
        isRepository: true,
        repositoryRoot: repository,
        branch,
        staged,
        unstaged,
        untracked,
        conflicted,
        commit
      };
    } catch (error) {
      // Check if it's actually a git repo
      try {
        await fsPromises.access(path.join(repoPath, '.git'));
      } catch {
        return {
          isRepository: false,
          error: 'Not a git repository'
        };
      }
      throw error;
    }
  }

  /**
   * Initialize a new git repository
   * @param {string} repoPath - Path where to initialize
   * @param {string} branchName - Initial branch name
   * @returns {Promise<void>}
   */
  async init(repoPath, branchName = 'master') {
    const initialBranch = typeof branchName === 'string' && branchName.trim() ? branchName.trim() : 'master';
    await this.execGit(['check-ref-format', '--branch', initialBranch], repoPath);
    await this.execGit(['init', '--initial-branch', initialBranch], repoPath);
  }

  /**
   * Stage changes
   * @param {string} repoPath - Repository path
   * @param {string[]} files - Files to stage (empty array = stage all)
   * @returns {Promise<void>}
   */
  async add(repoPath, files = []) {
    await this.assertNoExecutableConfig(repoPath);
    const args = ['add'];
    if (files.length === 0) {
      args.push('.');
    } else {
      args.push('--', ...files);
    }
    await this.execGit(args, repoPath);
  }

  /**
   * Unstage changes
   * @param {string} repoPath - Repository path
   * @param {string[]} files - Files to unstage
   * @returns {Promise<void>}
   */
  async reset(repoPath, files = []) {
    const args = ['reset'];
    if (files.length > 0) {
      args.push('--', ...files);
    }
    await this.execGit(args, repoPath);
  }

  /**
   * Commit staged changes
   * @param {string} repoPath - Repository path
   * @param {string} message - Commit message
   * @param {boolean} amend - Whether to amend the previous commit
   * @returns {Promise<void>}
   */
  async commit(repoPath, message, amend = false) {
    const args = ['commit'];
    if (amend) args.push('--amend');
    args.push('-m', message);
    await this.execGit(args, repoPath);
  }

  async commitMessage(repoPath) {
    return this.execGit(['log', '-1', '--pretty=%B'], repoPath);
  }

  /**
   * Get commit history
   * @param {string} repoPath - Repository path
   * @param {number} maxCount - Maximum number of commits to return
   * @returns {Promise<Array>}
   */
  async log(repoPath, maxCount = 10) {
    const limit = Number.isSafeInteger(maxCount) ? Math.max(1, Math.min(maxCount, 1000)) : 10;
    const format = '%H%x00%h%x00%an%x00%ae%x00%ar%x00%s%x00%S';
    const output = await this.execGit(
      ['log', '--all', '--source', '--pretty=format:' + format, `-n`, String(limit)],
      repoPath
    );

    return output.split('\n').map(line => {
      const [hash, shortHash, author, email, relativeDate, subject, source] = line.split('\0');
      const branch = (source || '').replace(/^refs\/(?:heads|remotes)\//, '') || 'unknown branch';
      return {hash, shortHash, author, email, relativeDate, subject, branch};
    });
  }

  async revertToCommit(repoPath, commitHash) {
    await this.assertNoExecutableConfig(repoPath);
    if (typeof commitHash !== 'string' || !/^[0-9a-f]{4,64}$/i.test(commitHash)) {
      throw new Error('Invalid commit');
    }
    const targetCommit = await this.execGit(['rev-parse', '--verify', `${commitHash}^{commit}`], repoPath);
    await this.execGit(['merge-base', '--is-ancestor', targetCommit, 'HEAD'], repoPath);
    const head = await this.execGit(['rev-parse', 'HEAD'], repoPath);
    if (head === targetCommit) {
      throw new Error('This is already the current commit');
    }
    try {
      await this.execGit(['revert', '--no-commit', `${targetCommit}..HEAD`], repoPath);
    } catch (error) {
      try {
        await this.execGit(['revert', '--abort'], repoPath);
      } catch (abortError) {
        // Preserve the original revert error.
      }
      throw error;
    }
    await this.commit(repoPath, `Revert to ${targetCommit.slice(0, 7)}`);
  }

  /**
   * List all branches
   * @param {string} repoPath - Repository path
   * @returns {Promise<Array>}
   */
  async listBranches(repoPath) {
    const output = await this.execGit([
      'for-each-ref',
      '--format=%(refname)%00%(refname:short)%00%(HEAD)',
      'refs/heads',
      'refs/remotes'
    ], repoPath, {trim: false});
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const [ref, name, head] = line.split('\0');
      return {
        name,
        ref,
        isCurrent: head === '*',
        isRemote: ref.startsWith('refs/remotes/')
      };
    }).filter(branch => !branch.ref.endsWith('/HEAD'));
  }

  /**
   * Update remote-tracking branches
   * @param {string} repoPath - Repository path
   * @param {string|null} remote - Remote name, or all remotes when omitted
   * @returns {Promise<void>}
   */
  async fetch(repoPath, remote = null) {
    if (remote) {
      await this.execGit(['fetch', '--prune', '--', await this.validateRemote(repoPath, remote)], repoPath);
      return;
    }
    const remotes = await this.execGit(['remote'], repoPath);
    for (const name of remotes.split(/\r?\n/).filter(Boolean)) {
      await this.execGit(['fetch', '--prune', '--', await this.validateRemote(repoPath, name)], repoPath);
    }
  }

  /**
   * Create a new branch
   * @param {string} repoPath - Repository path
   * @param {string} branchName - Name of the new branch
   * @returns {Promise<void>}
   */
  async createBranch(repoPath, branchName) {
    await this.assertNoExecutableConfig(repoPath);
    await this.execGit(['checkout', '-b', await this.validateBranch(repoPath, branchName)], repoPath);
  }

  async renameBranch(repoPath, branch, newName) {
    const currentName = branch.replace(/^refs\/heads\//, '');
    await this.validateBranch(repoPath, currentName);
    await this.validateBranch(repoPath, newName);
    await this.execGit(['branch', '-m', currentName, newName], repoPath);
  }

  async deleteBranch(repoPath, branch) {
    if (branch.startsWith('refs/remotes/')) {
      const remoteBranch = branch.replace(/^refs\/remotes\//, '');
      const separator = remoteBranch.indexOf('/');
      if (separator < 1) throw new Error('Invalid remote branch');
      const remote = remoteBranch.slice(0, separator);
      const name = remoteBranch.slice(separator + 1);
      await this.validateRemote(repoPath, remote);
      await this.validateBranch(repoPath, name);
      await this.execGit(['push', remote, '--delete', name], repoPath);
      return;
    }
    const localBranch = branch.replace(/^refs\/heads\//, '');
    await this.validateBranch(repoPath, localBranch);
    await this.execGit(['branch', '-d', localBranch], repoPath);
  }

  /**
   * Switch branch
   * @param {string} repoPath - Repository path
   * @param {string} branchName - Branch to switch to
   * @returns {Promise<void>}
   */
  async switchBranch(repoPath, branchName) {
    await this.assertNoExecutableConfig(repoPath);
    if (!branchName.startsWith('refs/remotes/')) {
      const localBranch = branchName.replace(/^refs\/heads\//, '');
      await this.execGit(['checkout', await this.validateBranch(repoPath, localBranch)], repoPath);
      return;
    }

    const remoteBranch = branchName.replace(/^refs\/remotes\//, '');
    const separator = remoteBranch.indexOf('/');
    if (separator < 1 || separator === remoteBranch.length - 1) throw new Error('Invalid remote branch');
    const remote = remoteBranch.substring(0, separator);
    const localName = remoteBranch.substring(separator + 1);
    await this.validateRemote(repoPath, remote);
    await this.validateBranch(repoPath, localName);
    const safeRemoteBranch = `${remote}/${localName}`;
    const localExists = await this.execGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${localName}`],
      repoPath
    ).then(() => true, () => false);
    if (localExists) {
      await this.execGit(['checkout', localName], repoPath);
      return;
    }
    await this.execGit(['checkout', '--track', '-b', localName, safeRemoteBranch], repoPath);
  }

  async readRevisionFile(repoPath, revision, filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    try {
      return await this.execGit(['show', `${revision}:${normalized}`], repoPath, {trim: false});
    } catch (error) {
      return null;
    }
  }

  async projectDiff(repoPath, filePath, staged = false, originalPath = null) {
    const normalized = filePath.replace(/\\/g, '/');
    const fullPath = path.resolve(repoPath, normalized);
    const repositoryRoot = path.resolve(repoPath);
    if (isOutsidePath(repositoryRoot, fullPath)) {
      throw new Error('Invalid project diff path');
    }
    const normalizedOriginal = originalPath ? originalPath.replace(/\\/g, '/') : null;
    if (normalizedOriginal) {
      const originalFullPath = path.resolve(repoPath, normalizedOriginal);
      if (isOutsidePath(repositoryRoot, originalFullPath)) {
        throw new Error('Invalid original project diff path');
      }
    }

    const kind = projectDiffKind(normalized);
    if (kind === 'asset') {
      return {path: normalized, kind, before: null, after: null};
    }

    const beforePath = normalizedOriginal || normalized;
    const before = staged ?
      await this.readRevisionFile(repoPath, 'HEAD', beforePath) :
      await this.readRevisionFile(repoPath, '', beforePath);
    let after;
    if (staged) {
      after = await this.readRevisionFile(repoPath, '', normalized);
    } else {
      after = await readWorkingTreeFile(repositoryRoot, fullPath);
    }

    const result = {
      path: normalized,
      originalPath: normalizedOriginal,
      kind,
      before,
      after
    };
    if (kind === 'blocks') {
      result.beforeProject = parseBlocksRevision(before, staged ? 'committed' : 'staged');
      result.afterProject = parseBlocksRevision(after, staged ? 'staged' : 'working');
    }
    return result;
  }

  /**
   * Push changes
   * @param {string} repoPath - Repository path
   * @param {string} remote - Remote name (default: origin)
   * @param {string} branch - Branch name (default: current)
   * @returns {Promise<void>}
   */
  async push(repoPath, remote = 'origin', branch = null) {
    const args = ['push', '--', await this.validateRemote(repoPath, remote)];
    if (branch) {
      args.push(await this.validateBranch(repoPath, branch));
    }
    await this.execGit(args, repoPath);
  }

  /**
   * Pull changes
   * @param {string} repoPath - Repository path
   * @param {string} remote - Remote name (default: origin)
   * @param {string} branch - Branch name (default: current)
   * @returns {Promise<void>}
   */
  async pull(repoPath, remote = 'origin', branch = null) {
    await this.assertNoExecutableConfig(repoPath);
    const args = ['pull', '--', await this.validateRemote(repoPath, remote)];
    if (branch) {
      args.push(await this.validateBranch(repoPath, branch));
    }
    await this.execGit(args, repoPath);
  }

  /**
   * Discard changes in a file
   * @param {string} repoPath - Repository path
   * @param {string} filePath - File path
   * @param {string|null} originalPath - Original path for a working-tree rename/copy
   * @returns {Promise<Object>}
   */
  async discard(repoPath, filePath, originalPath = null) {
    const repository = await this.resolveRepository(repoPath);
    const resolved = resolveGitPath(repository, filePath);
    await rejectSymbolicPathComponents(repository, resolved.filePath);
    if (originalPath) {
      const original = resolveGitPath(repository, originalPath, 'original file');
      await rejectSymbolicPathComponents(repository, original.filePath);
      const newPathIsTracked = await this.execGit(
        ['ls-files', '--error-unmatch', '--', resolved.filePath],
        repository
      ).then(() => true, () => false);
      if (newPathIsTracked) throw new Error('Working-tree rename destination is unexpectedly tracked');
      const originalIsTracked = await this.execGit(
        ['ls-files', '--error-unmatch', '--', original.filePath],
        repository
      ).then(() => true, () => false);
      if (!originalIsTracked) throw new Error('Working-tree rename source is not tracked');
      const destinationStat = await fsPromises.lstat(resolved.fullPath);
      if (destinationStat.isDirectory()) throw new Error('Cannot discard a renamed directory');
      const originalExists = await fsPromises.lstat(original.fullPath).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      const temporaryPath = `${resolved.fullPath}.discard-${process.pid}-${Date.now()}`;
      await fsPromises.rename(resolved.fullPath, temporaryPath);
      let restoredOriginal = false;
      try {
        if (!originalExists) {
          await this.execGit(['restore', '--worktree', '--', original.filePath], repository);
          restoredOriginal = true;
        }
        await fsPromises.rm(temporaryPath, {force: true});
      } catch (error) {
        if (restoredOriginal) await fsPromises.rm(original.fullPath, {force: true}).catch(() => {});
        await fsPromises.rename(temporaryPath, resolved.fullPath).catch(restoreError => {
          error.message += ` (also failed to restore the renamed file: ${restoreError.message})`;
        });
        throw error;
      }
      return {tracked: restoredOriginal};
    }
    let tracked = true;
    try {
      await this.execGit(['ls-files', '--error-unmatch', '--', resolved.filePath], repository);
    } catch (error) {
      tracked = false;
    }
    if (tracked) await this.execGit(['restore', '--worktree', '--', resolved.filePath], repository);
    else await fsPromises.rm(resolved.fullPath, {force: true});
    return {tracked};
  }

  /**
   * Get remote URLs
   * @param {string} repoPath - Repository path
   * @returns {Promise<Array>}
   */
  async remotes(repoPath) {
    const output = await this.execGit(['remote', '-v'], repoPath);
    const remotes = {};

    output.split('\n').forEach(line => {
      const match = line.match(/(\S+)\s+(\S+)\s+\((fetch|push)\)/);
      if (match) {
        const [, name, url, type] = match;
        if (!remotes[name]) {
          remotes[name] = {};
        }
        remotes[name][type] = url;
      }
    });

    return Object.entries(remotes).map(([name, urls]) => ({
      name,
      fetch: urls.fetch ? this.redactRemoteUrl(urls.fetch) : undefined,
      push: urls.push ? this.redactRemoteUrl(urls.push) : undefined
    }));
  }

  redactRemoteUrl(remoteUrl) {
    try {
      const parsed = new URL(remoteUrl);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch (error) {
      return 'Unsupported remote URL';
    }
  }

  async validateRemote(repoPath, remote) {
    if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new Error('Invalid remote');
    const remotes = await this.execGit(['remote'], repoPath);
    if (!remotes.split(/\r?\n/).includes(remote)) throw new Error('Unknown remote');
    const remoteUrl = await this.execGit(['remote', 'get-url', '--', remote], repoPath);
    this.validateRemoteUrl(remoteUrl);
    return remote;
  }

  validateRemoteUrl(remoteUrl) {
    let parsed;
    try {
      parsed = new URL(remoteUrl);
    } catch (error) {
      throw new Error('Git remotes must use an HTTP or HTTPS URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Git remotes must use an HTTP or HTTPS URL');
    }
  }

  async validateBranch(repoPath, branch) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Invalid branch');
    await this.execGit(['check-ref-format', '--branch', branch], repoPath);
    return branch;
  }

  async addRemote(repoPath, name, url) {
    if (typeof name !== 'string' || !name || name.startsWith('-')) throw new Error('Invalid remote name');
    await this.execGit(['check-ref-format', `refs/remotes/${name}/test`], repoPath);
    if (typeof url !== 'string' || !url || url.startsWith('-')) throw new Error('Invalid remote URL');
    this.validateRemoteUrl(url);
    await this.execGit(['remote', 'add', '--', name, url], repoPath);
  }

  async removeRemote(repoPath, name) {
    await this.execGit(['remote', 'remove', await this.validateRemote(repoPath, name)], repoPath);
  }

  async merge(repoPath, branch, targetBranch) {
    await this.assertNoExecutableConfig(repoPath);
    const source = branch.replace(/^refs\/heads\//, '');
    const target = targetBranch.replace(/^refs\/heads\//, '');
    if (!source || !target) throw new Error('Choose both a source and destination branch');
    if (source === target) throw new Error('Source and destination branches must be different');
    await this.validateBranch(repoPath, source);
    await this.validateBranch(repoPath, target);
    const originalCommit = await this.execGit(['rev-parse', 'HEAD'], repoPath);
    let originalBranch = null;
    try {
      originalBranch = await this.execGit(['symbolic-ref', '--short', 'HEAD'], repoPath);
    } catch (error) {
      // Detached HEAD: restore the exact commit if the merge fails.
    }
    let switched = false;
    try {
      await this.execGit(['checkout', target], repoPath);
      switched = true;
      await this.execGit(['merge', '--no-edit', source], repoPath);
    } catch (error) {
      if (switched) {
        await this.execGit(['merge', '--abort'], repoPath).catch(() => {});
        await this.execGit(['checkout', originalBranch || originalCommit], repoPath).catch(() => {});
      }
      throw error;
    }
  }

  async readReadme(repoPath) {
    const repository = await this.resolveRepository(repoPath);
    const readmePath = path.join(repository, 'README.md');
    await rejectSymbolicLink(readmePath);
    try {
      return await fsPromises.readFile(readmePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }

  async writeReadme(repoPath, contents) {
    const repository = await this.resolveRepository(repoPath);
    const readmePath = path.join(repository, 'README.md');
    await rejectSymbolicLink(readmePath);
    await fsPromises.writeFile(readmePath, String(contents), 'utf8');
  }
}

module.exports = new GitService();
