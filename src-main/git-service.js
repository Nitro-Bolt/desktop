const {spawn} = require('child_process');
const fsPromises = require('fs/promises');
const path = require('path');

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
   * @returns {Promise<string>} - Command output
   */
  execGit(args, cwd = null) {
    return new Promise((resolve, reject) => {
      const options = {};
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
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Git command failed with code ${code}`));
        }
      });

      git.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Get git repository status
   * @param {string} repoPath - Path to repository
   * @returns {Promise<Object>}
   */
  async status(repoPath) {
    try {
      const statusOutput = await this.execGit(['status', '--porcelain=v2', '--branch'], repoPath);
      let logOutput = '';
      try {
        logOutput = await this.execGit(['log', '--oneline', '-n', '1'], repoPath);
      } catch (err) {
        logOutput = '';
      }

      // Parse status
      const lines = statusOutput.split('\n');
      let branch = '';
      const staged = [];
      const unstaged = [];
      const untracked = [];

      for (const line of lines) {
        if (line.startsWith('# branch.oid')) {
          // Current commit hash
        } else if (line.startsWith('# branch.head')) {
          branch = line.substring('# branch.head '.length);
        } else if (line.startsWith('1 ')) {
          // Modified file
          const parts = line.split('\t');
          const status = parts[0];
          const filename = parts[1];

          if (status.includes('M')) {
            unstaged.push(filename);
          }
        } else if (line.startsWith('2 ')) {
          // Rename/copy
          const parts = line.split('\t');
          const filename = parts[2];
          unstaged.push(filename);
        } else if (line.startsWith('? ')) {
          // Untracked
          const filename = line.substring(2);
          untracked.push(filename);
        }
      }

      return {
        isRepository: true,
        branch,
        staged,
        unstaged,
        untracked,
        lastCommit: logOutput || 'No commits yet'
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
   * @returns {Promise<void>}
   */
  async init(repoPath) {
    await this.execGit(['init'], repoPath);
  }

  /**
   * Stage changes
   * @param {string} repoPath - Repository path
   * @param {string[]} files - Files to stage (empty array = stage all)
   * @returns {Promise<void>}
   */
  async add(repoPath, files = []) {
    const args = ['add'];
    if (files.length === 0) {
      args.push('.');
    } else {
      args.push(...files);
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
      args.push(...files);
    }
    await this.execGit(args, repoPath);
  }

  /**
   * Commit staged changes
   * @param {string} repoPath - Repository path
   * @param {string} message - Commit message
   * @param {string} author - Author name <email>
   * @returns {Promise<string>} - Commit hash
   */
  async commit(repoPath, message, author = null) {
    try {
      const args = ['commit', '-m', message];
      if (author) {
        args.push('--author', author);
      }
      const output = await this.execGit(args, repoPath);
      // Extract commit hash from output
      const match = output.match(/\[.+\s([a-f0-9]+)\]/);
      return match ? match[1] : output;
    } catch (error) {
      // Check if it's a user.name/user.email configuration issue
      if (error.message.includes('user.name') || error.message.includes('user.email')) {
        throw new Error('Git user.name and user.email not configured. Please set them globally or use: git config user.name "Your Name" && git config user.email "your@email.com"');
      }
      throw error;
    }
  }

  /**
   * Get commit history
   * @param {string} repoPath - Repository path
   * @param {number} maxCount - Maximum number of commits to return
   * @returns {Promise<Array>}
   */
  async log(repoPath, maxCount = 10) {
    const format = '%H|%h|%an|%ae|%ar|%s';
    const output = await this.execGit(
      ['log', '--pretty=format:' + format, `-n`, String(maxCount)],
      repoPath
    );

    return output.split('\n').map(line => {
      const [hash, shortHash, author, email, relativeDate, subject] = line.split('|');
      return {hash, shortHash, author, email, relativeDate, subject};
    });
  }

  /**
   * Get current branch
   * @param {string} repoPath - Repository path
   * @returns {Promise<string>}
   */
  async currentBranch(repoPath) {
    return await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  }

  /**
   * List all branches
   * @param {string} repoPath - Repository path
   * @returns {Promise<Array>}
   */
  async listBranches(repoPath) {
    const output = await this.execGit(['branch', '-a'], repoPath);
    return output.split('\n').map(line => {
      const isCurrent = line.startsWith('*');
      const name = line.substring(2).trim();
      return {name, isCurrent};
    }).filter(b => b.name);
  }

  /**
   * Create a new branch
   * @param {string} repoPath - Repository path
   * @param {string} branchName - Name of the new branch
   * @returns {Promise<void>}
   */
  async createBranch(repoPath, branchName) {
    await this.execGit(['checkout', '-b', branchName], repoPath);
  }

  /**
   * Switch branch
   * @param {string} repoPath - Repository path
   * @param {string} branchName - Branch to switch to
   * @returns {Promise<void>}
   */
  async switchBranch(repoPath, branchName) {
    await this.execGit(['checkout', branchName], repoPath);
  }

  /**
   * Get diff for a file
   * @param {string} repoPath - Repository path
   * @param {string} filePath - File path relative to repo
   * @returns {Promise<string>}
   */
  async diff(repoPath, filePath) {
    return await this.execGit(['diff', filePath], repoPath);
  }

  /**
   * Get staged diff for a file
   * @param {string} repoPath - Repository path
   * @param {string} filePath - File path relative to repo
   * @returns {Promise<string>}
   */
  async stagedDiff(repoPath, filePath) {
    return await this.execGit(['diff', '--cached', filePath], repoPath);
  }

  /**
   * Clone a repository
   * @param {string} url - Repository URL
   * @param {string} targetPath - Where to clone
   * @returns {Promise<void>}
   */
  async clone(url, targetPath) {
    await this.execGit(['clone', url, targetPath]);
  }

  /**
   * Push changes
   * @param {string} repoPath - Repository path
   * @param {string} remote - Remote name (default: origin)
   * @param {string} branch - Branch name (default: current)
   * @returns {Promise<string>}
   */
  async push(repoPath, remote = 'origin', branch = null) {
    const args = ['push', remote];
    if (branch) {
      args.push(branch);
    }
    return await this.execGit(args, repoPath);
  }

  /**
   * Pull changes
   * @param {string} repoPath - Repository path
   * @param {string} remote - Remote name (default: origin)
   * @param {string} branch - Branch name (default: current)
   * @returns {Promise<string>}
   */
  async pull(repoPath, remote = 'origin', branch = null) {
    const args = ['pull', remote];
    if (branch) {
      args.push(branch);
    }
    return await this.execGit(args, repoPath);
  }

  /**
   * Discard changes in a file
   * @param {string} repoPath - Repository path
   * @param {string} filePath - File path
   * @returns {Promise<void>}
   */
  async discard(repoPath, filePath) {
    await this.execGit(['checkout', 'HEAD', filePath], repoPath);
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
        const [, name, url] = match;
        if (!remotes[name]) {
          remotes[name] = {};
        }
      }
    });

    return Object.entries(remotes).map(([name, urls]) => ({name, ...urls}));
  }
}

module.exports = new GitService();
