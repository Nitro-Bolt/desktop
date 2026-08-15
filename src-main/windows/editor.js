const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const nodeURL = require('url');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
const {app, dialog} = require('electron');
const ProjectRunningWindow = require('./project-running-window');
const AddonsWindow = require('./addons');
const DesktopSettingsWindow = require('./desktop-settings');
const PrivacyWindow = require('./privacy');
const AboutWindow = require('./about');
const PackagerWindow = require('./packager');
const {createAtomicWriteStream} = require('../atomic-write-stream');
const {translate, updateLocale, getStrings} = require('../l10n');
const {APP_NAME} = require('../brand');
const prompts = require('../prompts');
const settings = require('../settings');
const privilegedFetch = require('../fetch');
const RichPresence = require('../rich-presence.js');
const FileAccessWindow = require('./file-access-window.js');
const ExtensionDocumentationWindow = require('./extension-documentation.js');
const gitService = require('../git-service');
const gitProject = require('../git-project');
const SecurityPromptWindow = require('./security-prompt.js');

const TYPE_FILE = 'file';
const TYPE_URL = 'url';
const TYPE_SCRATCH = 'scratch';
const TYPE_SAMPLE = 'sample';
const TYPE_GIT_PROJECT = 'git-project';

// possibly TODO: migrate to nitrobolt links..?

class OpenedFile {
  constructor (type, path) {
    /** @type {TYPE_FILE|TYPE_URL|TYPE_SCRATCH|TYPE_SAMPLE|TYPE_GIT_PROJECT} */
    this.type = type;

    /**
     * Absolute file path or URL
     * @type {string}
     */
    this.path = path;
  }

  async read () {
    if (this.type === TYPE_FILE) {
      return {
        name: path.basename(this.path),
        data: await fsPromises.readFile(this.path)
      };
    }

    if (this.type === TYPE_URL) {
      const buffer = await privilegedFetch(this.path);
      return {
        name: decodeURIComponent(path.basename(this.path)),
        data: buffer
      };
    }

    if (this.type === TYPE_SCRATCH) {
      const metadata = await privilegedFetch.json(`https://api.scratch.mit.edu/projects/${this.path}`);
      const token = metadata.project_token;
      const title = metadata.title;

      const projectBuffer = await privilegedFetch(`https://projects.scratch.mit.edu/${this.path}?token=${token}`);
      return {
        name: title,
        data: projectBuffer
      };
    }

    if (this.type === TYPE_SAMPLE) {
      const sampleRoot = path.resolve(__dirname, '../../dist-extensions/samples/');
      const resolvedPath = path.join(sampleRoot, this.path);
      if (resolvedPath.startsWith(sampleRoot)) {
        const compressedPath = `${resolvedPath}.br`;
        const compressedData = await fsPromises.readFile(compressedPath);

        // dist-extensions is all brotli'd; must decompress
        const decompressedData = await new Promise((resolve, reject) => {
          zlib.brotliDecompress(compressedData, (err, res) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          });
        });

        return {
          name: this.path,
          data: decompressedData
        };
      }
      throw new Error('Unsafe join');
    }

    if (this.type === TYPE_GIT_PROJECT) {
      return readGitProject(this.path);
    }

    throw new Error(`Unknown type: ${this.type}`);
  }
}

const parseLocalPath = (file, workingDirectory) => {
  const resolvedPath = path.resolve(workingDirectory || process.cwd(), file);
  try {
    if (fs.statSync(resolvedPath).isDirectory()) {
      return new OpenedFile(TYPE_GIT_PROJECT, resolvedPath);
    }
  } catch (e) {
    // Let the normal file-loading path report missing and inaccessible paths.
  }
  return new OpenedFile(TYPE_FILE, resolvedPath);
};

/**
 * @param {string} file
 * @param {string|null} workingDirectory
 * @returns {OpenedFile}
 */
const parseOpenedFile = (file, workingDirectory) => {
  let url;
  try {
    url = new URL(file);
  } catch (e) {
    // Error means it was not a valid full URL
  }

  if (url) {
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      // Scratch URLs require special treatment as they are not direct downloads.
      const scratchMatch = file.match(/^https?:\/\/scratch\.mit\.edu\/projects\/(\d+)\/?/);
      if (scratchMatch) {
        return new OpenedFile(TYPE_SCRATCH, scratchMatch[1]);
      }

      // Need to manually redirect extension samples to the copies we already have offline as the
      // fetching code will not go through web request handlers or custom protocols.
      const sampleMatch = file.match(/^https?:\/\/extensions\.turbowarp\.org\/samples\/(.+\.sb3)$/);
      if (sampleMatch) {
        return new OpenedFile(TYPE_SAMPLE, decodeURIComponent(sampleMatch[1]));
      }

      return new OpenedFile(TYPE_URL, file);
    }

    // Parse file:// URLs.
    // Notably we receive these in the flatpak version of the app when we can only access a file through
    // the XDG document portal instead of having direct access with eg. --filesystem=home
    if (url.protocol === 'file:') {
      let filePath;
      try {
        filePath = nodeURL.fileURLToPath(file);
      } catch (e) {
        // Very unlikely but possible
      }

      if (filePath) {
        return parseLocalPath(filePath, workingDirectory);
      }
    }

    // Don't throw an error just because we don't recognize the URL protocol as
    // Windows paths look close enough to real URLs to be parsed successfully.
  }

  return parseLocalPath(file, workingDirectory);
};

const registerResultHandler = (ipc, channel, operation, formatResult = () => ({})) => {
  ipc.handle(channel, async (_event, ...args) => {
    try {
      return {
        success: true,
        ...formatResult(await operation(...args))
      };
    } catch (error) {
      return {success: false, error: error instanceof Error ? error.message : String(error)};
    }
  });
};

const readGitProject = async selectedPath => {
  const projectPath = await gitService.resolveRepository(selectedPath);
  return {
    name: path.basename(projectPath),
    data: await gitProject.readProject(projectPath),
    projectPath
  };
};

/**
 * @returns {Array<{path: string; app: string;}>}
 */
const getUnsafePaths = () => {
  if (process.platform !== 'win32') {
    // This problem doesn't really exist on other platforms
    return [];
  }

  const localPrograms = path.join(app.getPath('home'), 'AppData', 'Local', 'Programs');
  const appData = app.getPath('appData');
  return [
    // Current app, regardless of where it is installed or how modded it is
    {
      path: path.dirname(app.getPath('exe')),
      app: APP_NAME,
    },
    {
      path: app.getPath('userData'),
      app: APP_NAME,
    },

    // NitroBolt Desktop fefaults
    {
      path: path.join(appData, 'nitrobolt-desktop'),
      app: 'NitroBolt Desktop'
    },
    {
      path: path.join(localPrograms, 'NitroBolt'),
      app: 'NitroBolt Desktop'
    },

    // TurboWarp Desktop defaults
    {
      path: path.join(appData, 'turbowarp-desktop'),
      app: 'TurboWarp Desktop'
    },
    {
      path: path.join(localPrograms, 'TurboWarp'),
      app: 'TurboWarp Desktop'
    },

    // Scratch Desktop defaults
    {
      path: path.join(appData, 'Scratch'),
      app: 'Scratch Desktop'
    },
    {
      path: path.join(localPrograms, 'Scratch 3'),
      app: 'Scratch Desktop'
    }
  ];
};

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
const isChildPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * @returns {string} A unique string.
 */
const generateFileId = () => {
  // Note that we can't use the randomUUID from web crypto as we need to support Electron 22.
  return `desktop_file_id{${nodeCrypto.randomUUID()}}`;
};

class EditorWindow extends ProjectRunningWindow {
  /**
   * @param {OpenedFile|null} initialFile
   * @param {boolean} isInitiallyFullscreen
   * @param {boolean} nodeIntegration
   */
  constructor (initialFile, isInitiallyFullscreen, nodeIntegration) {
    super({
      nodeIntegration
    });

    /**
     * Ideally we would revoke access after loading a new project, but our file handle handling in
     * the GUI isn't robust enough for that yet. We do at least use random file handle IDs which
     * makes it much harder for malicious code in the renderer process to enumerate all previously
     * opened IDs and overwrite them.
     * @type {Map<string, OpenedFile>}
     */
    this.openedFiles = new Map();
    this.activeFileId = null;

    if (initialFile !== null) {
      this.activeFileId = generateFileId();
      this.openedFiles.set(this.activeFileId, initialFile);
    }

    this.openedProjectAt = Date.now();

    /**
     * @param {string} id
     * @returns {OpenedFile}
     * @throws if invalid ID
     */
    const getFileById = (id) => {
      if (!this.openedFiles.has(id)) {
        throw new Error('Invalid file ID');
      }
      return this.openedFiles.get(id);
    };

    let processingWillPreventUnload = false;
    this.window.webContents.on('will-prevent-unload', () => {
      // Using showMessageBoxSync synchronously in the event handler causes broken focus on Windows.
      // See https://github.com/TurboWarp/desktop/issues/1245
      // To work around that, we won't cancel that will-prevent-unload event so the window stays
      // open. After a very short delay to let focus get fixed, we'll show a dialog and force close
      // the window ourselves if the user wants.

      // Due to the timeout, this event could theoretically fire multiple times before we show the
      // dialog. Make sure to only show one dialog if that happens.
      if (processingWillPreventUnload) {
        return;
      }
      processingWillPreventUnload = true;

      setTimeout(() => {
        const choice = dialog.showMessageBoxSync(this.window, {
          title: APP_NAME,
          type: 'info',
          buttons: [
            translate('unload.stay'),
            translate('unload.leave')
          ],
          cancelId: 0,
          defaultId: 0,
          message: translate('unload.message'),
          detail: translate('unload.detail'),
          noLink: true
        });
        if (choice === 1) {
          this.window.destroy();
        }
        processingWillPreventUnload = false;
      });
    });

    const titlePrefix = nodeIntegration ? `[${translate('node-integration.prefix')}] ` : '';
    this.window.on('page-title-updated', (event, title, explicitSet) => {
      event.preventDefault();
      if (explicitSet && title) {
        this.window.setTitle(`${titlePrefix}${title} - ${APP_NAME}`);
        this.projectTitle = title;
      } else {
        this.window.setTitle(`${titlePrefix}${APP_NAME}`);
        this.projectTitle = '';
      }

      this.updateRichPresence();
    });
    this.window.setTitle(`${titlePrefix}${APP_NAME}`);

    this.window.on('focus', () => {
      this.updateRichPresence();
    });

    this.ipc.on('is-initially-fullscreen', (e) => {
      e.returnValue = isInitiallyFullscreen;
    });

    this.ipc.handle('get-initial-file', () => {
      return this.activeFileId;
    });

    this.ipc.handle('get-file', async (event, id) => {
      const file = getFileById(id);
      const {name, data, projectPath} = await file.read();
      return {
        name,
        type: file.type,
        data,
        projectPath
      };
    });

    this.ipc.on('set-locale', async (event, locale) => {
      if (settings.locale !== locale) {
        settings.locale = locale;
        updateLocale(locale);

        // Imported late due to circular dependency
        const rebuildMenuBar = require('../menu-bar');
        rebuildMenuBar();

        // Let the save happen in the background, not important
        Promise.resolve().then(() => settings.save());
      }
      event.returnValue = {
        strings: getStrings()
      };
    });

    this.ipc.handle('set-changed', (event, changed) => {
      this.window.setDocumentEdited(changed);
    });

    this.ipc.handle('opened-file', (event, id) => {
      const file = getFileById(id);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }
      this.activeFileId = id;
      this.openedProjectAt = Date.now();
      this.window.setRepresentedFilename(file.path);
    });

    this.ipc.handle('closed-file', () => {
      this.activeFileId = null;
      this.window.setRepresentedFilename('');
    });

    this.ipc.handle('show-open-file-picker', async () => {
      const result = await dialog.showOpenDialog(this.window, {
        properties: ['openFile'],
        defaultPath: settings.lastDirectory,
        filters: [
          {
            name: 'Scratch Project',
            extensions: ['sb3', 'sb2', 'sb'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePaths[0];
      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('show-open-directory-picker', async () => {
      const result = await dialog.showOpenDialog(this.window, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: settings.lastDirectory
      });

      if (result.canceled) {
        return null;
      }

      const directoryPath = result.filePaths[0];
      settings.lastDirectory = directoryPath;
      await settings.save();

      return {
        name: path.basename(directoryPath),
        path: directoryPath
      };
    });

    this.ipc.handle('show-save-file-picker', async (event, suggestedName) => {
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: path.join(settings.lastDirectory, suggestedName),
        filters: [
          {
            name: 'Scratch 3 Project',
            extensions: ['sb3'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePath;

      const unsafePath = getUnsafePaths().find(i => isChildPath(i.path, filePath));
      if (unsafePath) {
        // No need to block until the message box is closed
        dialog.showMessageBox(this.window, {
          type: 'error',
          title: APP_NAME,
          message: translate('unsafe-path.title'),
          detail: translate(`unsafe-path.details`)
            .replace('{APP_NAME}', unsafePath.app)
            .replace('{file}', filePath),
          noLink: true
        });  
        return null;
      }

      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('get-preferred-media-devices', () => {
      return {
        microphone: settings.microphone,
        camera: settings.camera
      };
    });

    this.ipc.on('start-write-stream', async (startEvent, id) => {
      const file = getFileById(id);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }

      const port = startEvent.ports[0];

      /** @type {NodeJS.WritableStream|null} */
      let writeStream = null;

      const handleError = (error) => {
        console.error('Write stream error', error);
        port.postMessage({
          error
        });

        // Make sure the port is started in case we encounter an error before we normally
        // begin to accept messages.
        port.start();
      };

      try {
        writeStream = await createAtomicWriteStream(file.path);
      } catch (error) {
        handleError(error);
        return;
      }

      writeStream.on('atomic-error', handleError);

      const handleMessage = (data) => {
        if (data.write) {
          if (writeStream.write(data.write)) {
            // Still more space in the buffer. Ask for more immediately.
            return;
          }
          // Wait for the buffer to become empty before asking for more.
          return new Promise(resolve => {
            writeStream.once('drain', resolve);
          });
        } else if (data.finish) {
          // Wait for the atomic file write to complete.
          return new Promise(resolve => {
            writeStream.once('atomic-finish', resolve);
            writeStream.end();
          });
        } else if (data.abort) {
          writeStream.emit('error', new Error('Aborted by renderer process'));
          return;
        }
        throw new Error('Unknown message from renderer');
      };

      port.on('message', async (messageEvent) => {
        try {
          const data = messageEvent.data;
          const id = data.id;
          const result = await handleMessage(data);
          port.postMessage({
            response: {
              id,
              result
            }
          });
        } catch (error) {
          handleError(error);
        }
      });

      port.start();
    });

    this.ipc.on('alert', (event, message) => {
      event.returnValue = prompts.alert(this.window, message);
    });

    this.ipc.on('confirm', (event, message) => {
      event.returnValue = prompts.confirm(this.window, message);
    });

    this.ipc.handle('open-packager', () => {
      PackagerWindow.forEditor(this);
    });

    this.ipc.handle('open-new-window', () => {
      EditorWindow.newWindow(null, false, false);
    });

    this.ipc.handle('open-addon-settings', (event, search) => {
      AddonsWindow.show(search);
    });

    this.ipc.handle('open-desktop-settings', () => {
      DesktopSettingsWindow.show();
    });

    this.ipc.handle('open-privacy', () => {
      PrivacyWindow.show();
    });

    this.ipc.handle('open-about', () => {
      AboutWindow.show();
    });

    this.ipc.handle('get-advanced-customizations', async () => {
      const USERSCRIPT_PATH = path.join(app.getPath('userData'), 'userscript.js');
      const USERSTYLE_PATH = path.join(app.getPath('userData'), 'userstyle.css');

      const [userscript, userstyle] = await Promise.all([
        fsPromises.readFile(USERSCRIPT_PATH, 'utf-8').catch(() => ''),
        fsPromises.readFile(USERSTYLE_PATH, 'utf-8').catch(() => '')
      ]);

      return {
        userscript,
        userstyle
      };
    });

    this.ipc.handle('check-drag-and-drop-path', (event, filePath) => {
      FileAccessWindow.check(filePath);
    });

    this.ipc.handle('git-is-available', () => gitService.isGitAvailable());
    registerResultHandler(this.ipc, 'git-status', repoPath => gitService.status(repoPath), data => ({data}));
    registerResultHandler(this.ipc, 'git-init', (repoPath, branchName) => gitService.init(repoPath, branchName));
    registerResultHandler(this.ipc, 'git-add', (repoPath, files) => gitService.add(repoPath, files));
    registerResultHandler(this.ipc, 'git-reset', (repoPath, files) => gitService.reset(repoPath, files));
    registerResultHandler(this.ipc, 'git-commit', (repoPath, message) => gitService.commit(repoPath, message));
    registerResultHandler(this.ipc, 'git-log', (repoPath, maxCount) => gitService.log(repoPath, maxCount),
      commits => ({commits}));
    registerResultHandler(this.ipc, 'git-list-branches', repoPath => gitService.listBranches(repoPath),
      branches => ({branches}));
    registerResultHandler(this.ipc, 'git-create-branch', (repoPath, branchName) =>
      gitService.createBranch(repoPath, branchName));
    registerResultHandler(this.ipc, 'git-switch-branch', (repoPath, branchName) =>
      gitService.switchBranch(repoPath, branchName));
    registerResultHandler(this.ipc, 'git-push', (repoPath, remote, branch) =>
      gitService.push(repoPath, remote, branch));
    registerResultHandler(this.ipc, 'git-pull', (repoPath, remote, branch) =>
      gitService.pull(repoPath, remote, branch));
    registerResultHandler(this.ipc, 'git-discard', (repoPath, filePath, originalPath) =>
      gitService.discard(repoPath, filePath, originalPath), result => result);
    registerResultHandler(this.ipc, 'git-remotes', repoPath => gitService.remotes(repoPath),
      remotes => ({remotes}));
    registerResultHandler(this.ipc, 'git-rename-branch', (repoPath, branch, newName) =>
      gitService.renameBranch(repoPath, branch, newName));
    registerResultHandler(this.ipc, 'git-delete-branch', (repoPath, branch) =>
      gitService.deleteBranch(repoPath, branch));
    registerResultHandler(this.ipc, 'git-revert-to-commit', (repoPath, commitHash) =>
      gitService.revertToCommit(repoPath, commitHash));
    registerResultHandler(this.ipc, 'git-add-remote', (repoPath, name, url) =>
      gitService.addRemote(repoPath, name, url));
    registerResultHandler(this.ipc, 'git-remove-remote', (repoPath, name) =>
      gitService.removeRemote(repoPath, name));
    registerResultHandler(this.ipc, 'git-merge', (repoPath, branch, targetBranch) =>
      gitService.merge(repoPath, branch, targetBranch));
    registerResultHandler(this.ipc, 'git-read-readme', repoPath => gitService.readReadme(repoPath),
      contents => ({contents}));
    registerResultHandler(this.ipc, 'git-write-readme', (repoPath, contents) =>
      gitService.writeReadme(repoPath, contents));
    registerResultHandler(this.ipc, 'git-project-diff', (repoPath, filePath, staged, originalPath) =>
      gitService.projectDiff(repoPath, filePath, staged, originalPath), data => ({data}));
    registerResultHandler(this.ipc, 'git-sync-project', (repoPath, archive, workspaceXML) =>
      gitProject.syncProject(repoPath, archive, workspaceXML));
    registerResultHandler(this.ipc, 'git-read-project', readGitProject,
      result => ({data: result.data, repositoryRoot: result.projectPath}));

    /**
     * Refers to the full screen button in the editor, not the OS-level fullscreen through
     * F11/Alt+Enter (Windows, Linux) or buttons provided by the OS (macOS).
     */
    this.isInEditorFullScreen = false;

    this.ipc.handle('set-is-full-screen', (event, isFullScreen) => {
      this.isInEditorFullScreen = !!isFullScreen;
    });

    this.loadURL('nb-editor://./gui/gui.html');
    this.show();
  }

  getPreload () {
    return 'editor';
  }

  getDimensions () {
    return {
      width: 1280,
      height: 800
    };
  }

  getBackgroundColor () {
    return '#333333';
  }

  applySettings () {
    this.window.webContents.setBackgroundThrottling(settings.backgroundThrottling);
  }

  enumerateMediaDevices () {
    // Used by desktop settings
    return new Promise((resolve, reject) => {
      this.ipc.once('enumerated-media-devices', (event, result) => {
        if (typeof result.error !== 'undefined') {
          reject(result.error);
        } else {
          resolve(result.devices);
        }
      });
      this.window.webContents.send('enumerate-media-devices');
    });
  }

  handleWindowOpen (details) {
    const url = new URL(details.url);
    const params = new URLSearchParams(url.search);

    // Open extension sample projects in-app
    if (
      url.protocol === 'nb-editor:' &&
      url.host === '.' &&
      params.has('project_url')
    ) {
      const projectUrl = params.get('project_url');
      const parsedFile = parseOpenedFile(projectUrl, null);
      if (parsedFile.type === TYPE_SAMPLE) {
        EditorWindow.newWindow(parsedFile, false, false);
        return {
          action: 'deny'
        };
      }
    }

    // Open extension documentation in-app
    const extensionsDocsMatch = details.url.match(
      /^https:\/\/extensions\.turbowarp\.org\/([\w_\-.\/]+)$/
    );
    if (extensionsDocsMatch) {
      ExtensionDocumentationWindow.open(extensionsDocsMatch[1]);
      return {
        action: 'deny'
      };
    }

    return super.handleWindowOpen(details);
  }

  canExitFullscreenByPressingEscape () {
    return !this.isInEditorFullScreen;
  }

  updateRichPresence () {
    RichPresence.setActivity(this.projectTitle, this.openedProjectAt);
  }

  /**
   * @param {string[]} paths
   * @param {boolean} fullscreen
   * @param {boolean} nodeIntegration
   * @param {string|null} workingDirectory
   * @returns {Promise<void>}
   */
  static openPaths (paths, fullscreen, nodeIntegration, workingDirectory) {
    if (paths.length === 0) {
      return EditorWindow.newWindow(null, fullscreen, nodeIntegration);
    }
    return Promise.all(paths.map(path => (
      EditorWindow.newWindow(parseOpenedFile(path, workingDirectory), fullscreen, nodeIntegration)
    )));
  }

  /**
   * Try to open a new window.
   * @param {OpenedFile|null} file
   * @param {boolean} fullscreen
   * @param {boolean} nodeIntegration
   * @returns {Promise<void>}
   */
  static async newWindow (file, fullscreen, nodeIntegration) {
    if (nodeIntegration) {
      const allowed = await SecurityPromptWindow.requestNodeIntegration();
      if (!allowed) {
        return;
      }
    }
    new EditorWindow(file, fullscreen, nodeIntegration);
  }
}

module.exports = EditorWindow;
