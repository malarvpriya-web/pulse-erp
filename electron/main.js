const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const path = require('path');

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function getAppUrl() {
  for (const port of [5173, 5174, 5175, 5176]) {
    if (await checkPort(port)) return `http://localhost:${port}`;
  }
  return 'http://localhost:5173';
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.ico'),
    title: 'Pulse ERP',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#7c3aed',
    // Hidden native title bar + coloured overlay (Windows)
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#7c3aed',        // purple background
      symbolColor: '#ffffff',  // white min/max/close icons
      height: 40,
    },
    show: false,
    autoHideMenuBar: true,
  });

  const appUrl = process.env.PULSE_URL || await getAppUrl();
  console.log('Loading:', appUrl);
  win.loadURL(appUrl);

  win.once('ready-to-show', () => win.show());

  // Keep title updated
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('Pulse ERP');
  });

  // Open external links in browser, not Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
