'use strict';
// A small, fixed set of desktop functions for the page. Nothing else of the PC is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('psmDesktop', {
  printers: () => ipcRenderer.invoke('psm:printers'),
  print: (jobs, opts) => ipcRenderer.invoke('psm:print', jobs, opts),
  openDrawer: (printer) => ipcRenderer.invoke('psm:openDrawer', printer),
  autostart: (on) => ipcRenderer.invoke('psm:autostart', on),
  notify: (title, body) => ipcRenderer.invoke('psm:notify', title, body),
  pickFolder: (title) => ipcRenderer.invoke('psm:pickFolder', title),
  openPath: (kind) => ipcRenderer.invoke('psm:openPath', kind),
  restoreBackup: (name) => ipcRenderer.invoke('psm:restoreBackup', name),
  setLanguage: (lang) => ipcRenderer.invoke('psm:setLanguage', lang),
  onNavigate: (cb) => ipcRenderer.on('psm:navigate', (_e, page) => cb(String(page))),
  licenseId: () => ipcRenderer.invoke('psm:licenseId'),
  licenseActivate: (key) => ipcRenderer.invoke('psm:licenseActivate', key),
  licenseState: () => ipcRenderer.invoke('psm:licenseState'),
  licenseLogin: (username, password) => ipcRenderer.invoke('psm:licenseLogin', username, password),
});
