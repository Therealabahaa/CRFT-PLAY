// Desktop app: runs the server inside the app and shows it in its own window.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, Notification, nativeTheme, screen } = require('electron');

const APP_NAME = 'crft Play';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.pscyber.manager');
// The app was "PlayStation Cyber" before it was crft Play, and Electron names its folder after the app - the folder the database lives in.
// Pinned to the old name, so every shop's data, window size and settings stay exactly where they are.
app.setPath('userData', path.join(app.getPath('appData'), 'PlayStation Cyber'));

// Only one copy of the app may run (one database, one cash drawer).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Keep the database in the user's AppData so it survives app updates/reinstalls.
process.env.PSM_DATA_DIR = process.env.PSM_DATA_DIR || path.join(app.getPath('userData'), 'data');

let win = null;
let info = null;
let lang = 'ar';
let quitting = false;
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const L = (ar, en) => (lang === 'en' ? en : ar);
// the exact address the server listens on: "localhost" goes to IPv6 first, where another program can own the same port and show its own site
const ORIGIN = () => `http://127.0.0.1:${info.port}`;
const isOurs = (url) => { try { return new URL(url).origin === ORIGIN(); } catch { return false; } };

/* ---------- window size & position are remembered ---------- */
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    const area = screen.getDisplayMatching(s.bounds).workArea;
    const visible = s.bounds.x < area.x + area.width && s.bounds.x + s.bounds.width > area.x && s.bounds.y < area.y + area.height && s.bounds.y + s.bounds.height > area.y;
    return visible ? s : { maximized: true };
  } catch { return { maximized: true }; }
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ }
}

/* ---------- menu (follows the app's language) ---------- */
const PAGES = [['floor', 'الغرف', 'Rooms'], ['pos', 'بيع سريع', 'Quick sale'], ['reservations', 'الحجوزات', 'Reservations'], ['customers', 'العملاء والديون', 'Customers & debts'],
  ['invoices', 'الفواتير', 'Invoices'], ['inventory', 'المخزن', 'Inventory'], ['shift', 'الوردية', 'Shift'], ['reports', 'التقارير', 'Reports'], ['settings', 'الإعدادات', 'Settings']];
function buildMenu() {
  const go = (page) => win && win.webContents.send('psm:navigate', page);
  const template = [
    {
      label: L('البرنامج', 'App'),
      submenu: [
        { label: L('عنوان الشبكة (للأجهزة الأخرى)', 'Network address (for other devices)'), click: showNetwork },
        { label: L('فتح مجلد البيانات', 'Open data folder'), click: () => shell.openPath(process.env.PSM_DATA_DIR) },
        ...(app.isPackaged ? [{ label: L('شغّل البرنامج مع ويندوز', 'Start with Windows'), type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) }] : []),
        { type: 'separator' },
        { label: L('خروج', 'Quit'), accelerator: 'Alt+F4', click: () => win ? win.close() : app.quit() },
      ],
    },
    { label: L('انتقال', 'Go'), submenu: PAGES.map(([p, ar, en]) => ({ label: L(ar, en), click: () => go(p) })) },
    {
      label: L('عرض', 'View'),
      submenu: [
        { label: L('تحديث', 'Reload'), accelerator: 'F5', click: () => win && win.webContents.reload() },
        { label: L('ملء الشاشة', 'Full screen'), accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { type: 'separator' },
        { label: L('تكبير', 'Zoom in'), accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: L('تصغير', 'Zoom out'), accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: L('الحجم الطبيعي', 'Actual size'), accelerator: 'CmdOrCtrl+0', click: () => win && win.webContents.setZoomLevel(0) },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.toggleDevTools() }]),
      ],
    },
    {
      label: L('مساعدة', 'Help'),
      submenu: [{ label: L(`عن ${APP_NAME}`, `About ${APP_NAME}`), click: () => dialog.showMessageBox(win, {
        type: 'info', title: APP_NAME, message: `${APP_NAME} ${app.getVersion()}`,
        detail: `${L('البيانات', 'Data')}: ${process.env.PSM_DATA_DIR}\n${L('على الشبكة', 'On the network')}: ${info.lan.join('  ') || '—'}`,
      }) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (win) win.setMenuBarVisibility(false); // shown with Alt, like other Windows apps
}

function zoom(delta) {
  if (!win) return;
  win.webContents.setZoomLevel(win.webContents.getZoomLevel() + delta);
}

function showNetwork() {
  const lines = info.lan.length ? info.lan.join('\n') : L('مفيش اتصال بالشبكة', 'No network connection found');
  dialog.showMessageBox(win, {
    type: 'info', title: APP_NAME, buttons: ['OK'],
    message: L('افتح العنوان ده من أي جهاز على نفس الواي فاي:', 'Open this address from any device on the same Wi-Fi:'),
    detail: lines,
  });
}

/* ---------- closing while the shop is working ---------- */
function busyState() {
  try {
    const { db } = require('../src/db');
    return {
      sessions: db.prepare("SELECT COUNT(*) n FROM sessions WHERE status != 'ended'").get().n,
      shift: !!db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL').get(),
    };
  } catch { return { sessions: 0, shift: false }; }
}

function createWindow() {
  const st = loadWindowState();
  win = new BrowserWindow({
    ...(st.bounds || { width: 1366, height: 860 }),
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#f3f1ec',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.on('maximize', saveWindowState);
  win.on('unmaximize', saveWindowState);

  // Nothing opens inside the app except the app itself; web links open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isOurs(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOurs(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // Right-click: cut / copy / paste in text boxes, copy on selected text (the page draws its own menus elsewhere).
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    Menu.buildFromTemplate([
      ...(p.isEditable ? [{ role: 'cut', label: L('قص', 'Cut') }] : []),
      { role: 'copy', label: L('نسخ', 'Copy') },
      ...(p.isEditable ? [{ role: 'paste', label: L('لصق', 'Paste') }] : []),
      { type: 'separator' },
      { role: 'selectAll', label: L('تحديد الكل', 'Select all') },
    ]).popup({ window: win });
  });

  // Files (Excel reports, backups) are saved with the normal Windows "Save as" window, then shown in their folder.
  win.webContents.session.on('will-download', (_e, item) => {
    const target = dialog.showSaveDialogSync(win, {
      title: L('حفظ الملف', 'Save file'),
      defaultPath: path.join(app.getPath('documents'), item.getFilename()),
      buttonLabel: L('حفظ', 'Save'),
    });
    if (!target) { item.cancel(); return; }
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      const n = new Notification({ title: L('تم حفظ الملف', 'File saved'), body: path.basename(target), icon: ICON });
      n.on('click', () => shell.showItemInFolder(target));
      n.show();
      shell.showItemInFolder(target);
    });
  });

  // Ask before closing while rooms are running or a shift is open.
  win.on('close', (e) => {
    if (quitting) return;
    const b = busyState();
    if (!b.sessions && !b.shift) return;
    const parts = [];
    if (b.sessions) parts.push(L(`${b.sessions} غرفة شغالة`, `${b.sessions} room(s) are running`));
    if (b.shift) parts.push(L('في وردية مفتوحة', 'a shift is open'));
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', title: APP_NAME, noLink: true, defaultId: 0, cancelId: 2,
      buttons: [L('تصغير بدل القفل', 'Minimize instead'), L('اقفل البرنامج', 'Close anyway'), L('إلغاء', 'Cancel')],
      message: L('متأكد إنك عايز تقفل البرنامج؟', 'Close the app?'),
      detail: `${parts.join(' · ')}.\n${L('الوقت هيفضل يتحسب، بس التابلت والموبايل وبوت تليجرام هيقفوا لحد ما تفتح البرنامج تاني.', 'Room timers keep counting, but tablets, phones and the Telegram bot stop working until the app is opened again.')}`,
    });
    if (choice === 1) { quitting = true; return; }
    e.preventDefault();
    if (choice === 0) win.minimize();
  });
  win.on('closed', () => { win = null; });
  win.loadURL(`${ORIGIN()}/`);
}

/* ---------- desktop functions the page may call (see preload.js) ---------- */
ipcMain.handle('psm:setLanguage', (_e, l) => { lang = l === 'en' ? 'en' : 'ar'; buildMenu(); });
ipcMain.handle('psm:notify', (_e, title, body) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || APP_NAME), body: String(body || ''), icon: ICON });
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  n.show();
  if (win && !win.isFocused()) win.flashFrame(true);
  return true;
});
ipcMain.handle('psm:pickFolder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: String(title || ''), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? '' : (r.filePaths[0] || '');
});
ipcMain.handle('psm:openPath', async (_e, kind) => {
  const backup = require('../src/backup');
  const target = kind === 'backups' ? backup.backupDir() : process.env.PSM_DATA_DIR;
  return shell.openPath(target);
});
// Restore a backup: confirm, keep a safety copy of today's data, put the backup in place and restart.
ipcMain.handle('psm:restoreBackup', async (_e, name) => {
  const backup = require('../src/backup');
  const file = backup.filePath(String(name || ''));
  if (!file) return { ok: false, error: 'not_found' };
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning', title: APP_NAME, noLink: true, defaultId: 1, cancelId: 1,
    buttons: [L('استرجع النسخة', 'Restore it'), L('إلغاء', 'Cancel')],
    message: L('استرجاع النسخة الاحتياطية؟', 'Restore this backup?'),
    detail: `${name}\n\n${L('كل البيانات هترجع زي ما كانت وقت النسخة دي. هيتعمل نسخة من بيانات النهارده الأول، والبرنامج هيعيد التشغيل.', 'All data goes back to how it was at that backup. A copy of today\'s data is saved first, then the app restarts.')}`,
  });
  if (choice !== 0) return { ok: false, cancelled: true };
  try {
    backup.run('before-restore');
    const { db, DB_PATH } = require('../src/db');
    db.close();
    for (const ext of ['-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
    fs.copyFileSync(file, DB_PATH);
    quitting = true;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

require('./printing').register();

// ---- licence: the installed app only starts on a PC that has a key made for its machine ID (see license.js). `npm run app` (development) is not checked.
// A crft account works too (account.js): the subscription token crft.live gives is saved in the same file.
const lic = require('./license');
const account = require('./account');
const LIC_FILE = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'PlayStation Cyber', 'license.key');
const savedLicence = () => { try { return fs.readFileSync(LIC_FILE, 'utf8').trim(); } catch { return ''; } };
const saveLicence = (text) => { fs.mkdirSync(path.dirname(LIC_FILE), { recursive: true }); fs.writeFileSync(LIC_FILE, String(text).trim()); };
const licState = () => lic.status(lic.machineId(), savedLicence());
const licensed = () => licState().ok;
let activation = null;
ipcMain.handle('psm:licenseId', () => lic.machineId());
ipcMain.handle('psm:licenseState', () => licState());
ipcMain.handle('psm:licenseActivate', (_e, key) => {
  if (!lic.verify(lic.machineId(), key) || account.isToken(key)) return false;
  saveLicence(key);
  setImmediate(startApp);
  return true;
});
ipcMain.handle('psm:licenseLogin', async (_e, username, password) => {
  const r = await account.activate('play', lic.machineId(), String(username || ''), String(password || ''), require('os').hostname());
  if (!r.ok || !r.token) return { ok: false, error: r.error, error_ar: r.error_ar };
  if (!lic.status(lic.machineId(), r.token).ok) return { ok: false, error: 'crft.live answered, but the answer was not valid for this PC.', error_ar: 'crft.live رد، بس الرد مش صالح للجهاز ده.' };
  saveLicence(r.token);
  setImmediate(startApp);
  return { ok: true };
});
function activationWindow() {
  Menu.setApplicationMenu(null);
  activation = new BrowserWindow({ width: 540, height: 640, resizable: false, title: `Activate ${APP_NAME}`, icon: ICON, backgroundColor: '#111111', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') } });
  activation.loadFile(path.join(__dirname, 'license.html'));
  activation.on('closed', () => { activation = null; if (!licensed()) app.quit(); });
}

const checkLicence = app.isPackaged || process.env.PSM_LICENCE === '1'; // PSM_LICENCE=1 tries the activation screen from source
// automatic updates from crft.live, signed by crft (see updater.js). The installed app only. Started as soon as the
// app opens — also on the activation screen — so a copy locked for being too old can still update itself.
let updater = null;
function startUpdater() {
  if (updater || !app.isPackaged) return updater;
  const parent = () => (win && !win.isDestroyed() ? win : undefined);
  const notes = (m) => [m.notes?.ar, m.notes?.en].filter(Boolean).join('\n') + (m.notes?.ar || m.notes?.en ? '\n\n' : '');
  updater = require('./updater').start({
    app: 'play', name: 'crft Play', version: app.getVersion(), exe: process.execPath,
    ask: (m) => dialog.showMessageBox(parent(), {
      type: 'info', buttons: ['حدّث الآن · Update now', 'لاحقًا · Later'], defaultId: 0, cancelId: 1, title: APP_NAME,
      message: `نسخة جديدة من crft Play جاهزة (${m.version})\ncrft Play ${m.version} is ready to install.`,
      detail: notes(m) + 'هيقفل البرنامج دقيقة ويفتح لوحده، والأجهزة والبيانات زي ما هي.\ncrft Play closes for about a minute and opens again by itself. Your data stays exactly as it is.',
    }).then((r) => r.response === 0),
    // a required update: one button, no "Later" — this version no longer works
    mustUpdate: (m) => dialog.showMessageBox(parent(), {
      type: 'warning', buttons: ['حدّث الآن · Update now'], defaultId: 0, cancelId: 0, noLink: true, title: APP_NAME,
      message: `لازم تحدّث crft Play لنسخة ${m.version}\nAn update to crft Play ${m.version} is required.`,
      detail: notes(m) + 'النسخة اللي على الجهاز ده مبقتش شغالة. هيقفل البرنامج دقيقة ويفتح لوحده، والأجهزة والبيانات زي ما هي.\nThe version on this PC no longer works. crft Play closes for about a minute and opens again by itself. Your data stays exactly as it is.',
    }),
    // updates are bought: only versions this PC's updates cover are offered
    canUpdate: (m) => account.canUpdate('play', lic.machineId(), savedLicence(), m.version),
    outOfPlan: (m, c) => dialog.showMessageBox(parent(), {
      type: 'info', buttons: ['حسنًا · OK'], defaultId: 0, title: APP_NAME,
      message: `نسخة جديدة من crft Play نزلت (${m.version})\ncrft Play ${m.version} is out.`,
      detail: `تحديثاتك خلصت يوم ${c.updates_until}. نسختك الحالية هتفضل شغالة عادي — كلّم crft لو عايز تجدد التحديثات وتاخد الجديد.\nYour updates ended on ${c.updates_until}. Your current version keeps working — contact crft to renew updates and get the new one.`,
    }),
    quit: () => app.quit(), log: (m) => console.log(m),
  });
  return updater;
}
app.whenReady().then(async () => {
  startUpdater(); // first, so even a copy that can't open (too old to renew) still gets its update
  // a crft account's token that lapsed while the PC was off: renewed now if there is internet, before asking anyone
  if (checkLicence && !licensed() && account.isToken(savedLicence())) {
    const r = await account.refresh('play', lic.machineId(), savedLicence());
    if (r.ok && r.token && lic.status(lic.machineId(), r.token).ok) saveLicence(r.token);
    else if (r.update_required) updater?.check();
  }
  if (!checkLicence || licensed()) startApp(); else activationWindow();
});

let started = false;
async function startApp() {
  if (started) return;
  started = true;
  try {
    const { start } = require('../server');
    info = await start(3000);
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `تعذر تشغيل البرنامج / Could not start:\n${err.stack || err.message}`);
    app.quit();
    return;
  }
  // a till should come back by itself after a restart or power cut: switched on once, the first time the installed app runs
  if (app.isPackaged) {
    const mark = path.join(app.getPath('userData'), 'autostart-set');
    if (!fs.existsSync(mark)) { app.setLoginItemSettings({ openAtLogin: true }); try { fs.writeFileSync(mark, new Date().toISOString()); } catch { /* fine */ } }
    // renamed to crft Play: Windows may still be told to start the old "PlayStation Cyber.exe", which the update removed - the till would
    // quietly stop coming back after a power cut. If that entry is there, start this exe instead and drop it. Switched off = no entry = stays off.
    try {
      const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', cp = require('child_process');
      const oldEntries = () => [...cp.execFileSync('reg', ['query', RUN], { windowsHide: true }).toString().matchAll(/^ {4}(.+?) {4}REG_\w+ {4}(.*)$/gm)]
        .filter((m) => /\\PlayStation Cyber\.exe"?(\s|$)/i.test(m[2])).map((m) => m[1]);
      if (oldEntries().length) {
        app.setLoginItemSettings({ openAtLogin: true });
        for (const name of oldEntries()) cp.execFileSync('reg', ['delete', RUN, '/v', name, '/f'], { windowsHide: true });
      }
    } catch { /* nothing to move, or no permission: fine */ }
  }
  try { lang = require('../src/db').settings().language === 'en' ? 'en' : 'ar'; } catch { /* default */ }
  createWindow();
  buildMenu();
  // a crft account: keep its token renewed, and say so a week before the subscription ends
  if (checkLicence) {
    account.keepFresh({ app: 'play', machineId: lic.machineId, file: LIC_FILE, log: (m) => console.log(m), onUpdateRequired: () => startUpdater()?.check() });
    const st = licState();
    if (st.kind === 'account' && st.daysLeft <= 7) setTimeout(() => dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', title: APP_NAME, buttons: ['حسنًا · OK'],
      message: st.daysLeft === 0 ? 'اشتراك crft Play بينتهي النهارده.\nYour crft Play subscription ends today.'
        : `اشتراك crft Play بينتهي يوم ${st.endsOn} (فاضل ${st.daysLeft} يوم).\nYour crft Play subscription ends on ${st.endsOn} (${st.daysLeft} days left).`,
      detail: 'كلّم crft للتجديد. · Contact crft to renew it.',
    }), 3000);
  }
  if (activation) activation.destroy(); // the main window exists first, so closing this one doesn't quit the app
}

app.on('before-quit', () => { quitting = true; saveWindowState(); });
app.on('window-all-closed', () => app.quit());
