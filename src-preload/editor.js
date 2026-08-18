const {contextBridge, ipcRenderer} = require('electron');

const exposeInMainWorld = (name, api) => {
  // TODO: find a better way to do this
  try {
    contextBridge.exposeInMainWorld(name, api);
  } catch (e) {
    global[name] = api;
  }
};

exposeInMainWorld('EditorPreload', {
  isInitiallyFullscreen: () => ipcRenderer.sendSync('is-initially-fullscreen'),
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  getFile: (id) => ipcRenderer.invoke('get-file', id),
  openedFile: (id) => ipcRenderer.invoke('opened-file', id),
  closedFile: () => ipcRenderer.invoke('closed-file'),
  showSaveFilePicker: (suggestedName) => ipcRenderer.invoke('show-save-file-picker', suggestedName),
  showOpenDirectoryPicker: () => ipcRenderer.invoke('show-open-directory-picker'),
  showOpenFilePicker: () => ipcRenderer.invoke('show-open-file-picker'),
  setLocale: (locale) => ipcRenderer.sendSync('set-locale', locale),
  setChanged: (changed) => ipcRenderer.invoke('set-changed', changed),
  openNewWindow: () => ipcRenderer.invoke('open-new-window'),
  openAddonSettings: (search) => ipcRenderer.invoke('open-addon-settings', search),
  openPackager: () => ipcRenderer.invoke('open-packager'),
  openDesktopSettings: () => ipcRenderer.invoke('open-desktop-settings'),
  openPrivacy: () => ipcRenderer.invoke('open-privacy'),
  openAbout: () => ipcRenderer.invoke('open-about'),
  getPreferredMediaDevices: () => ipcRenderer.invoke('get-preferred-media-devices'),
  getAdvancedCustomizations: () => ipcRenderer.invoke('get-advanced-customizations'),
  setExportForPackager: (callback) => {
    exportForPackager = callback;
  },
  setIsFullScreen: (isFullScreen) => ipcRenderer.invoke('set-is-full-screen', isFullScreen)
});

exposeInMainWorld('Git', {
  isAvailable: () => ipcRenderer.invoke('git-is-available'),
  status: (repoPath) => ipcRenderer.invoke('git-status', repoPath),
  init: (repoPath, branchName) => ipcRenderer.invoke('git-init', repoPath, branchName),
  add: (repoPath, files = []) => ipcRenderer.invoke('git-add', repoPath, files),
  reset: (repoPath, files = []) => ipcRenderer.invoke('git-reset', repoPath, files),
  commit: (repoPath, message) => ipcRenderer.invoke('git-commit', repoPath, message),
  revertToCommit: (repoPath, commitHash) => ipcRenderer.invoke('git-revert-to-commit', repoPath, commitHash),
  log: (repoPath, maxCount = 10) => ipcRenderer.invoke('git-log', repoPath, maxCount),
  listBranches: (repoPath) => ipcRenderer.invoke('git-list-branches', repoPath),
  fetch: (repoPath, remote = null) => ipcRenderer.invoke('git-fetch', repoPath, remote),
  createBranch: (repoPath, branchName) => ipcRenderer.invoke('git-create-branch', repoPath, branchName),
  renameBranch: (repoPath, branch, newName) => ipcRenderer.invoke('git-rename-branch', repoPath, branch, newName),
  deleteBranch: (repoPath, branch) => ipcRenderer.invoke('git-delete-branch', repoPath, branch),
  switchBranch: (repoPath, branchName) => ipcRenderer.invoke('git-switch-branch', repoPath, branchName),
  projectDiff: (repoPath, filePath, staged = false, originalPath = null) =>
    ipcRenderer.invoke('git-project-diff', repoPath, filePath, staged, originalPath),
  push: (repoPath, remote = 'origin', branch) => ipcRenderer.invoke('git-push', repoPath, remote, branch),
  pull: (repoPath, remote = 'origin', branch) => ipcRenderer.invoke('git-pull', repoPath, remote, branch),
  discard: (repoPath, filePath, originalPath = null) =>
    ipcRenderer.invoke('git-discard', repoPath, filePath, originalPath),
  remotes: (repoPath) => ipcRenderer.invoke('git-remotes', repoPath),
  addRemote: (repoPath, name, url) => ipcRenderer.invoke('git-add-remote', repoPath, name, url),
  removeRemote: (repoPath, name) => ipcRenderer.invoke('git-remove-remote', repoPath, name),
  merge: (repoPath, branch, targetBranch) => ipcRenderer.invoke('git-merge', repoPath, branch, targetBranch),
  readReadme: (repoPath) => ipcRenderer.invoke('git-read-readme', repoPath),
  writeReadme: (repoPath, contents) => ipcRenderer.invoke('git-write-readme', repoPath, contents),
  syncProject: (repoPath, archive, workspaceXML) =>
    ipcRenderer.invoke('git-sync-project', repoPath, archive, workspaceXML),
  readProject: (repoPath) => ipcRenderer.invoke('git-read-project', repoPath)
});

let exportForPackager = () => Promise.reject(new Error('exportForPackager missing'));

ipcRenderer.on('export-project-to-port', (e) => {
  const port = e.ports[0];
  exportForPackager()
    .then(({data, name}) => {
      port.postMessage({ data, name });
    })
    .catch((error) => {
      console.error(error);
      port.postMessage({ error: true });
    });
});

window.addEventListener('message', (e) => {
  if (e.source === window) {
    const data = e.data;
    if (data && typeof data.ipcStartWriteStream === 'string') {
      ipcRenderer.postMessage('start-write-stream', data.ipcStartWriteStream, e.ports);
    }
  }
});

ipcRenderer.on('enumerate-media-devices', (e) => {
  navigator.mediaDevices.enumerateDevices()
    .then((devices) => {
      e.sender.send('enumerated-media-devices', {
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          kind: device.kind,
          label: device.label
        }))
      });
    })
    .catch((error) => {
      console.error(error);
      e.sender.send('enumerated-media-devices', {
        error: `${error}`
      });
    });
});

exposeInMainWorld('PromptsPreload', {
  alert: (message) => ipcRenderer.sendSync('alert', message),
  confirm: (message) => ipcRenderer.sendSync('confirm', message),
});

// In some Linux environments, people may try to drag & drop files that we don't have access to.
// Remove when https://github.com/electron/electron/issues/30650 is fixed.
if (navigator.userAgent.includes('Linux')) {
  document.addEventListener('drop', (e) => {
    if (e.isTrusted) {
      for (const file of e.dataTransfer.files) {
        // Using webUtils is safe as we don't have a legacy build for Linux
        const {webUtils} = require('electron');
        const path = webUtils.getPathForFile(file);
        ipcRenderer.invoke('check-drag-and-drop-path', path);
      }
    }
  }, {
    capture: true
  });
}
