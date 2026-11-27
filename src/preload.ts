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
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
};

contextBridge.exposeInMainWorld('umm', api);
