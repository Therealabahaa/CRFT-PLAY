// Receipt printing + cash drawer for the desktop app (ported from Kur's main.js).
//  - "driver" mode: the receipt HTML is rendered in a hidden window and printed silently to the chosen printer
//    (or with the Windows print window when the user picked "Ask each time").
//  - "direct" mode: the receipt is drawn as a picture at the printer's resolution and sent as ESC/POS raster bytes,
//    straight to the printer — Arabic always prints right because the Windows driver can't garble it.
//  - The cash drawer opens with the standard ESC/POS pulse, sent as a RAW job to the receipt printer.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');

const DRAWER_HEX = '1B 70 00 19 FA 1B 70 01 19 FA';
const RAW_CS = `using System; using System.Runtime.InteropServices;
public class PsmRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] public class DOCINFOA { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)] public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)] public static extern bool StartDocPrinter(IntPtr h, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)] public static extern bool WritePrinter(IntPtr h, IntPtr b, Int32 n, out Int32 w);
  public static string Send(string printer, byte[] bytes) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "Windows cannot open the printer '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")";
    string err = null; DOCINFOA di = new DOCINFOA(); di.pDocName = "crft Play"; di.pDataType = "RAW";
    if (StartDocPrinter(h, 1, di)) {
      if (StartPagePrinter(h)) { IntPtr p = Marshal.AllocCoTaskMem(bytes.Length); Marshal.Copy(bytes, 0, p, bytes.Length); int w; if (!WritePrinter(h, p, bytes.Length, out w)) err = "The printer did not accept the data (error " + Marshal.GetLastWin32Error() + ")"; Marshal.FreeCoTaskMem(p); EndPagePrinter(h); }
      else err = "The printer did not start the job (error " + Marshal.GetLastWin32Error() + ")";
      EndDocPrinter(h);
    } else err = "The printer did not start the job (error " + Marshal.GetLastWin32Error() + ")";
    ClosePrinter(h); return err == null ? "OK" : err;
  }
}`;
// Compiling the helper takes a few seconds, so one PowerShell stays running and each job is one line: "<base64>|<printer>".
const RAW_LOOP = `Add-Type -TypeDefinition @'\n${RAW_CS}\n'@\n[Console]::Out.WriteLine('READY')\nwhile (($line = [Console]::In.ReadLine()) -ne $null) {\n  try { $i = $line.IndexOf('|'); $b = [Convert]::FromBase64String($line.Substring(0, $i)); [Console]::Out.WriteLine('RESULT|' + [PsmRaw]::Send($line.Substring($i + 1), $b)) }\n  catch { [Console]::Out.WriteLine('RESULT|' + $_.Exception.Message) }\n}`;

let rawProc = null, rawWaiting = null, rawReady = null;
function rawHelper() {
  if (rawProc && rawReady) return rawReady;
  let buf = '', onReady;
  rawReady = new Promise((r) => { onReady = r; });
  const p = rawProc = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(RAW_LOOP, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'READY') onReady(true);
      else if (line.startsWith('RESULT|') && rawWaiting) { const w = rawWaiting; rawWaiting = null; w(line.slice(7)); }
    }
  });
  const dead = () => {
    if (rawProc === p) { rawProc = null; rawReady = null; }
    onReady(false);
    if (rawWaiting) { const w = rawWaiting; rawWaiting = null; w('The printing helper stopped — try again'); }
  };
  p.on('exit', dead); p.on('error', dead); p.stderr.on('data', () => {});
  return rawReady;
}
let rawChain = Promise.resolve();
function rawSend(printer, bytes) {
  const run = async () => {
    if (!await Promise.race([rawHelper(), new Promise((r) => setTimeout(() => r(false), 25000))])) return 'Could not start the printing helper';
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        rawWaiting = null;
        // the helper may still be busy with this job: restart it, so its late answer can't be taken
        // as the result of the NEXT job (a drawer kick reporting a receipt's error, and so on)
        try { if (rawProc) rawProc.kill(); } catch { /* already gone */ }
        rawProc = null; rawReady = null;
        resolve('The printer did not answer');
      }, 30000);
      rawWaiting = (r) => { clearTimeout(t); resolve(r); };
      rawProc.stdin.write(`${Buffer.from(bytes).toString('base64')}|${printer}\n`);
    });
  };
  const result = rawChain.then(run, run);
  rawChain = result.catch(() => {});
  return result;
}

// The chosen printer, else the Windows default (Electron can't always tell which that is, so Windows is asked).
async function receiptPrinter(sender, wanted) {
  let name = String(wanted || '');
  if (!name || name === '__ask') {
    const list = await sender.getPrintersAsync();
    name = (list.find((p) => p.isDefault) || {}).name || '';
    if (!name) {
      name = await new Promise((resolve) => cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Printer | Where-Object { $_.Default }).Name'],
        { windowsHide: true, timeout: 10000 }, (_e, so) => resolve(String(so || '').trim().split(/\r?\n/)[0] || '')));
    }
    if (!name && list.length === 1) name = list[0].name;
  }
  return name;
}

const printTimed = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, error: 'The receipt took too long to print — check the printer and try again' }), 45000))]);

async function printViaDriver(job, opts) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(job.html || '')));
    if (process.env.PSM_PRINT_PDF_DIR) { // testing: save instead of printing
      const pdf = await w.webContents.printToPDF({ pageSize: { width: opts.paper === '58' ? 2.28 : 3.15, height: 8 }, margins: { marginType: 'none' } });
      fs.mkdirSync(process.env.PSM_PRINT_PDF_DIR, { recursive: true });
      const file = path.join(process.env.PSM_PRINT_PDF_DIR, `${Date.now()}-receipt.pdf`);
      fs.writeFileSync(file, pdf);
      return { ok: true, file };
    }
    const ask = opts.printer === '__ask';
    await new Promise((resolve, reject) => w.webContents.print(
      { silent: !ask, printBackground: false, margins: { marginType: 'none' }, ...(opts.printer && !ask ? { deviceName: opts.printer } : {}) },
      (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'The printer did not accept the job')))));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

// Draw the receipt at 203 dpi (8 dots/mm), turn it into black/white dots and send it as an ESC/POS raster image.
const DOTS_PER_PX = 203 / 96;
async function printDirect(job, opts, printer) {
  const dots = opts.paper === '58' ? 384 : 576;
  const w = new BrowserWindow({ show: false, useContentSize: true, width: dots, height: 800, enableLargerThanScreen: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(job.html || '')));
    w.webContents.setZoomFactor(DOTS_PER_PX);
    await w.webContents.insertCSS('html, body { overflow: hidden !important; background: #fff !important }');
    const fullH = Math.ceil(await w.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'));
    const rows = [];
    const rowBytes = dots / 8;
    const viewCss = Math.max(50, await w.webContents.executeJavaScript('window.innerHeight'));
    let lastTop = -1;
    for (let top = 0, pieces = 0; top < fullH && pieces < 500; pieces++) {
      await w.webContents.executeJavaScript(`window.scrollTo(0, ${top}); new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 400); })`);
      const actualTop = await w.webContents.executeJavaScript('window.scrollY');
      if (actualTop <= lastTop + 0.5) break;
      const skipCss = Math.max(0, top - actualTop);
      let img = await w.webContents.capturePage();
      if (!img.getSize().width) throw new Error('Could not draw the receipt');
      img = img.resize({ width: dots, quality: 'best' });
      const { width: iw, height: ih } = img.getSize();
      const px = img.toBitmap();
      const from = Math.round(skipCss * DOTS_PER_PX);
      const to = Math.min(ih, Math.round(Math.min(viewCss, fullH - actualTop) * DOTS_PER_PX));
      for (let y = from; y < to; y++) {
        const row = Buffer.alloc(rowBytes);
        for (let x = 0; x < Math.min(iw, dots); x++) {
          const i = (y * iw + x) * 4;
          if (px[i] * 0.114 + px[i + 1] * 0.587 + px[i + 2] * 0.299 < 200) row[x >> 3] |= 0x80 >> (x & 7);
        }
        rows.push(row);
      }
      lastTop = actualTop;
      top = actualTop + viewCss;
    }
    while (rows.length > 1 && rows[rows.length - 1].every((b) => b === 0)) rows.pop();
    // ESC @ (reset) · picture in bands (GS v 0) · feed 4 lines and cut
    const parts = [Buffer.from([0x1b, 0x40])];
    for (let y = 0; y < rows.length; y += 128) {
      const band = rows.slice(y, y + 128);
      parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, band.length & 0xff, band.length >> 8]), ...band);
    }
    parts.push(Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]));
    const bytes = Buffer.concat(parts);
    if (process.env.PSM_PRINT_RAW_DIR) { // testing: save the bytes and a preview of exactly what the printer gets
      fs.mkdirSync(process.env.PSM_PRINT_RAW_DIR, { recursive: true });
      const base = path.join(process.env.PSM_PRINT_RAW_DIR, `${Date.now()}-receipt`);
      fs.writeFileSync(base + '.bin', bytes);
      const bmp = Buffer.alloc(dots * rows.length * 4, 255);
      rows.forEach((r, y) => { for (let x = 0; x < dots; x++) if (r[x >> 3] & (0x80 >> (x & 7))) { const i = (y * dots + x) * 4; bmp[i] = bmp[i + 1] = bmp[i + 2] = 0; } });
      fs.writeFileSync(base + '.png', nativeImage.createFromBitmap(bmp, { width: dots, height: Math.max(1, rows.length) }).toPNG());
      return { ok: true, file: base + '.bin', printer };
    }
    const text = String(await rawSend(printer, bytes)).trim();
    return text === 'OK' ? { ok: true, printer } : { ok: false, error: text.split('\n').pop().slice(0, 200) || 'The printer did not accept the receipt' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

function register() {
  ipcMain.handle('psm:printers', async (e) => (await e.sender.getPrintersAsync()).map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault })));

  ipcMain.handle('psm:print', async (e, jobs, opts = {}) => {
    opts = opts || {};
    const direct = opts.direct && opts.printer !== '__ask';
    let printer = '';
    if (direct) { try { printer = await receiptPrinter(e.sender, opts.printer); } catch { /* reported below */ } }
    const results = [];
    for (const job of Array.isArray(jobs) ? jobs : []) {
      let r;
      if (!direct) r = opts.printer === '__ask' ? await printViaDriver(job, opts) : await printTimed(printViaDriver(job, opts));
      else if (!printer) r = { ok: false, error: 'No printer found — choose the receipt printer in Settings → Printing' };
      else r = await printTimed(printDirect(job, opts, printer));
      results.push(r);
    }
    return results;
  });

  ipcMain.handle('psm:openDrawer', async (e, wanted) => {
    try {
      const name = await receiptPrinter(e.sender, wanted);
      if (!name) return { ok: false, error: 'No printer chosen — choose the receipt printer the drawer is plugged into (Settings → Printing)' };
      if (process.env.PSM_DRAWER_FILE) { fs.writeFileSync(process.env.PSM_DRAWER_FILE, `${name}|${DRAWER_HEX}`); return { ok: true, printer: name }; }
      const text = String(await rawSend(name, Buffer.from(DRAWER_HEX.replace(/ /g, ''), 'hex'))).trim();
      return text === 'OK' ? { ok: true, printer: name } : { ok: false, error: text.split('\n').pop().slice(0, 200) || 'The drawer did not open' };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // Start with Windows — so after a restart or power cut the app (and the Telegram bot) come back by themselves.
  ipcMain.handle('psm:autostart', (_e, on) => {
    if (!app.isPackaged) return null;
    if (typeof on === 'boolean') app.setLoginItemSettings({ openAtLogin: on });
    return app.getLoginItemSettings().openAtLogin;
  });

  if (process.platform === 'win32' && !process.env.PSM_DRAWER_FILE) app.whenReady().then(() => setTimeout(() => rawHelper(), 4000));
  app.on('will-quit', () => { try { if (rawProc) rawProc.kill(); } catch { /* already gone */ } });
}

module.exports = { register };
