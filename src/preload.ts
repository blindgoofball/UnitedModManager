import { contextBridge, ipcRenderer } from 'electron';

const api: UmmApi = {
  listMods: () => ipcRenderer.invoke('mods:list'),
  getMod: (id) => ipcRenderer.invoke('mods:get', id),
  getFeed: (force) => ipcRenderer.invoke('home:feed', force),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  chooseGameFolder: (gameId) => ipcRenderer.invoke('games:choose-folder', gameId),
  clearGameFolder: (gameId) => ipcRenderer.invoke('games:clear-folder', gameId),
  planInstall: (modId, methodId, gameVersion) => ipcRenderer.invoke('install:plan', modId, methodId, gameVersion),
  planRemove: (modId) => ipcRenderer.invoke('install:plan-remove', modId),
  runPlan: (planId, confirmedIds) => ipcRenderer.invoke('install:run', planId, confirmedIds),
  onInstallProgress: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, p: InstallProgress): void => listener(p);
    ipcRenderer.on('install:progress', handler);
    return () => void ipcRenderer.removeListener('install:progress', handler);
  },
  buildSubmission: (form) => ipcRenderer.invoke('submit:build', form),
  checkSubmission: (json) => ipcRenderer.invoke('submit:check', json),
  copySubmission: (json) => ipcRenderer.invoke('submit:copy', json),
  saveSubmission: (json) => ipcRenderer.invoke('submit:save', json),
  openSubmissionOnGithub: (json) => ipcRenderer.invoke('submit:open-github', json),
  onCatalogChanged: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on('catalog:changed', handler);
    return () => void ipcRenderer.removeListener('catalog:changed', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
};

contextBridge.exposeInMainWorld('umm', api);
