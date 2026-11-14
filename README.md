# crft Play — نظام إدارة البلايستيشن

crft Play (formerly PlayStation Cyber Manager; internal names, the appId and the data folder still say PlayStation Cyber on purpose, so existing shops update in place) is a management system for PlayStation gaming cafés ("cybers"). It runs on the cashier PC, works fully offline, and other devices on the shop Wi-Fi (another PC, a tablet, the owner's phone) can open it in a browser. The interface is in Arabic (RTL) by default, with English available, and all prices are in EGP.

## Install (desktop app)

Run **`dist/crft-Play-Setup-1.0.0.exe`** on the shop PC. It installs the app with a desktop and Start-menu shortcut. Copy the installer to a USB stick to install on another PC. Nothing else is needed (no Node.js, no browser).

**First login:** `admin` / `admin`. Change it right away under Settings → My account (a red banner reminds you until you do).

- Data is stored in `%APPDATA%\PlayStation Cyber\data` (menu: **البرنامج → فتح مجلد البيانات**). Reinstalling or updating keeps it.
- **Other devices** (tablet, phone, another PC) can use the system while the app is open: menu **البرنامج → عنوان الشبكة** shows the address, e.g. `http://192.168.1.2:3000`. Windows Firewall may ask to allow access the first time; click Allow.
- Only one copy of the app runs at a time. Closing the window stops the system for other devices too.

**Activation (one time per PC):** the installed app first shows a machine ID. The buyer sends it to you; you run `node keygen/make-key.js <machine ID>` and send back the key. The key only works on that PC, so a copied install won't start elsewhere. It is saved in `%LOCALAPPDATA%\PlayStation Cyber\license.key`. Your master key works on any PC. The `keygen/` folder is not packed into the installer: never send it to anyone. Running from source skips the check; `set PSM_LICENCE=1` turns it on to try the activation screen.

## For developers

- `npm install`, then `npm run app` to run the desktop app from source (or double-click `start.bat`)
- `npm run server` runs the server only (browser mode)
- `npm run dist` builds the Windows installer into `dist/`
- `npm test` runs the end-to-end test

## What's included

| Area | Features |
|---|---|
| **Consoles (main screen)** | Live card per console: available / in use / paused / time up / maintenance. Start (open time, fixed time with countdown and beep, or a package). Pause and resume (pauses aren't charged). Switch single ↔ multi mid-session (each period keeps its own rate). Move a session to another console. Add drinks and snacks to the session. End & pay. Cancel a mistaken session (needs permission). |
| **Pricing** | Per-console hourly rate for *single* (up to 2 controllers) and *multi* (3+); PS4/PS5/VIP rooms each have their own prices. Packages (e.g. 2 hours = 70 EGP), with overtime charged at the normal rate. Round up to the nearest X EGP, minimum minutes, free grace minutes. |
| **Cashier** | Split payments: cash, card, mobile wallet (Vodafone Cash etc.), InstaPay. Change calculator. Discounts (permission). Unpaid remainder goes to the customer's debt. Printable 80 mm receipt. Refunds with reason and optional restock. |
| **Shifts** | Opening cash. Only one drawer/shift open at a time. Expected cash = opening + cash payments − cash refunds − drawer expenses. Banknote counter (200…0.5). Shortage/surplus recorded. Shift history. |
| **Inventory** | Products with cost and selling price. Stock deducted automatically on sale. Supplier purchases (weighted-average cost, optionally paid from the drawer). Waste/damage. Stock count. Low-stock warnings. Full movement history. |
| **Customers & debts** | Customer list with phone numbers. Debt ledger (every debt and payment with who/when). Pay off debts. |
| **Reservations** | Book a console for a time, with overlap protection. Shown on the console card and the main screen. Start a session from a reservation. No-show / cancel. |
| **Expenses** | Rent, electricity, internet, maintenance, controllers, salaries, other. Optionally paid from the drawer. |
| **Reports** | Today / yesterday / 7 days / month / custom. PlayStation vs product revenue, product profit, expenses, waste, net profit, collected by method, discounts, debts. Daily chart, busy-hours chart, console usage and utilization, top products, per-cashier totals. **Export to Excel** (9 sheets, Arabic or English). |
| **Employees** | Admin and cashier roles, plus per-cashier permissions: discounts, refunds, inventory, expenses, reports, settings. Activity log of every important action (logins, discounts, refunds, price changes, shift closes…). |
| **Backups** | Automatic backup every N hours (default 6, keeps the last 30; checked at startup and every 10 minutes), plus a "Back up now" button and download. Tip: set the backup folder to a USB drive or another disk. |

## Restoring a backup

1. Close the app (close the black console window).
2. Copy the backup file (e.g. `data/backups/cyber-2026-10-20_18-00-00-auto.db`) over `data/cyber.db`, and delete `data/cyber.db-wal` and `data/cyber.db-shm` if they exist.
3. Start the app again.

## Project layout

```
server.js               Express server, startup, sample data
src/db.js               SQLite schema & helpers
src/auth.js             Login, password hashing, permissions
src/billing.js          Invoices, stock deduction, payments, debts, refunds
src/backup.js           Backups (VACUUM INTO) + scheduler
src/routes/*.js         API: sessions, cashier (sales/shifts/customers), ops (inventory/expenses/reservations), reports, admin
public/js/pricing.js    Pricing engine shared by server and browser (live timer = final bill)
public/js/pages/*.js    Screens
public/js/i18n.js       Arabic / English text
test/smoke.js           End-to-end test (npm test)
```

All data lives in `data/cyber.db`. Run `npm test` to check that everything works; it uses a temporary database and doesn't touch your data.
