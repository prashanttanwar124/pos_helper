const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');
const { BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = electron;
const app = electron.app || require('electron/main').app;

const HOST = '127.0.0.1';
const PORT = 8090;
const HELPER_URL = `http://${HOST}:${PORT}/health`;
const DEV_RUNTIME_DIR = path.join(__dirname, '..', '.desktop-runtime');
const DEV_APP_DATA_DIR = path.join(DEV_RUNTIME_DIR, 'electron-data');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let helperProcess = null;
let helperStartupError = null;

if (!app.isPackaged) {
  const userDataDir = path.join(DEV_APP_DATA_DIR, 'userData');
  const sessionDataDir = path.join(DEV_APP_DATA_DIR, 'sessionData');
  const logsDir = path.join(DEV_APP_DATA_DIR, 'logs');

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(sessionDataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  app.setPath('userData', userDataDir);
  app.setPath('sessionData', sessionDataDir);
  app.setAppLogsPath(logsDir);
}

function getSupportDir() {
  return path.join(app.getPath('userData'), 'helper-runtime');
}

function getLogDir() {
  return path.join(getSupportDir(), 'logs');
}

function getLogPath() {
  return path.join(getLogDir(), 'helper.log');
}

function createTrayImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <rect x="2" y="2" width="14" height="14" rx="4" fill="#111111"/>
      <rect x="5" y="5" width="8" height="2" rx="1" fill="#ffffff"/>
      <rect x="5" y="8" width="5" height="2" rx="1" fill="#ffffff"/>
      <rect x="5" y="11" width="8" height="2" rx="1" fill="#ffffff"/>
    </svg>
  `;

  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  );
  image.setTemplateImage(true);
  return image.resize({ width: 18, height: 18 });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 560,
    title: 'NFC Helper Control',
    backgroundColor: '#f3efe5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBundledNodePath() {
  if (process.platform === 'win32') {
    return path.join(process.resourcesPath, 'runtime', 'node.exe');
  }

  return path.join(process.resourcesPath, 'runtime', 'node');
}

function getDevBundledNodePath() {
  if (process.platform === 'win32') {
    return path.join(DEV_RUNTIME_DIR, 'runtime', 'node.exe');
  }

  return path.join(DEV_RUNTIME_DIR, 'runtime', 'node');
}

function getHelperNodePath() {
  if (app.isPackaged) {
    return getBundledNodePath();
  }

  const devBundledNodePath = getDevBundledNodePath();
  if (fs.existsSync(devBundledNodePath)) {
    return devBundledNodePath;
  }

  return process.env.NFC_HELPER_NODE_PATH || process.env.npm_node_execpath || 'node';
}

function getHelperScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'helper', 'index.js');
  }

  const devHelperScriptPath = path.join(DEV_RUNTIME_DIR, 'helper', 'index.js');
  if (fs.existsSync(devHelperScriptPath)) {
    return devHelperScriptPath;
  }

  return path.join(__dirname, '..', 'index.js');
}

function getHelperWorkingDirectory() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'helper');
  }

  const devHelperDir = path.join(DEV_RUNTIME_DIR, 'helper');
  if (fs.existsSync(devHelperDir)) {
    return devHelperDir;
  }

  return path.join(__dirname, '..');
}

async function readHealthStatus() {
  try {
    const response = await fetch(HELPER_URL, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) {
      throw new Error(`Health check failed with ${response.status}`);
    }
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function getHelperStatus() {
  const health = await readHealthStatus();

  if (health && health.success) {
    return {
      running: true,
      host: HOST,
      port: PORT,
      reader_connected: health.reader_connected,
      reader_name: health.reader_name,
      pending_operation: health.pending_operation,
      last_seen_uid: health.last_seen_uid,
      last_read_at: health.last_read_at,
      last_error: health.last_error || helperStartupError,
      recent_actions: health.recent_actions || [],
    };
  }

  return {
    running: Boolean(helperProcess && !helperProcess.killed),
    host: HOST,
    port: PORT,
    reader_connected: false,
    reader_name: null,
    pending_operation: null,
    last_seen_uid: null,
    last_read_at: null,
    last_error: helperStartupError,
    recent_actions: [],
  };
}

function statusSummary(status) {
  if (!status.running) {
    return 'Helper stopped';
  }

  if (status.reader_connected) {
    return `Reader connected: ${status.reader_name || 'Unknown reader'}`;
  }

  return 'Helper running, reader not connected';
}

async function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const status = await getHelperStatus();
  const menu = Menu.buildFromTemplate([
    {
      label: status.running ? 'Helper: Running' : 'Helper: Stopped',
      enabled: false,
    },
    {
      label: status.reader_connected
        ? `Reader: ${status.reader_name || 'Connected'}`
        : 'Reader: Not connected',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Control Panel',
      click: () => showWindow(),
    },
    {
      label: 'Start Helper',
      click: async () => {
        await startHelper();
        await updateTrayMenu();
        showWindow();
      },
    },
    {
      label: 'Stop Helper',
      click: async () => {
        await stopHelper();
        await updateTrayMenu();
      },
    },
    {
      label: 'Open Logs',
      click: () => shell.showItemInFolder(getLogPath()),
    },
    { type: 'separator' },
    {
      label: 'Quit NFC Helper',
      click: async () => {
        isQuitting = true;
        await stopHelper();
        app.quit();
      },
    },
  ]);

  tray.setToolTip(`NFC Helper Control\n${statusSummary(status)}`);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.on('click', () => showWindow());
  tray.on('right-click', () => {
    updateTrayMenu();
  });
  updateTrayMenu();
}

async function startHelper() {
  const currentStatus = await getHelperStatus();
  if (currentStatus.running) {
    return currentStatus;
  }

  fs.mkdirSync(getLogDir(), { recursive: true });
  helperStartupError = null;
  fs.appendFileSync(
    getLogPath(),
    `[${new Date().toISOString()}] desktop: Starting helper process\n`
  );

  const out = fs.createWriteStream(getLogPath(), { flags: 'a' });
  const helperNode = getHelperNodePath();
  const helperScriptPath = getHelperScriptPath();

  helperProcess = spawn(helperNode, [helperScriptPath], {
    cwd: getHelperWorkingDirectory(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  helperProcess.once('error', (error) => {
    helperStartupError = `Failed to launch helper: ${error.message}`;
    fs.appendFileSync(
      getLogPath(),
      `[${new Date().toISOString()}] desktop-error: ${helperStartupError}\n`
    );
  });

  helperProcess.stdout.pipe(out);
  helperProcess.stderr.pipe(out);
  helperProcess.on('exit', (code, signal) => {
    if (code !== 0) {
      helperStartupError = `Helper exited early with code ${code}${signal ? ` (signal ${signal})` : ''}.`;
      fs.appendFileSync(
        getLogPath(),
        `[${new Date().toISOString()}] desktop-error: ${helperStartupError}\n`
      );
    }
    helperProcess = null;
    updateTrayMenu();
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await getHelperStatus();
    if (status.running) {
      return status;
    }
    await wait(300);
  }

  if (!helperStartupError) {
    helperStartupError = 'Helper did not become healthy in time. Open Logs for details.';
    fs.appendFileSync(
      getLogPath(),
      `[${new Date().toISOString()}] desktop-error: ${helperStartupError}\n`
    );
  }

  return getHelperStatus();
}

async function stopHelper() {
  if (!helperProcess) {
    return getHelperStatus();
  }

  const processToStop = helperProcess;
  helperProcess = null;
  helperStartupError = null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      processToStop.kill('SIGKILL');
    }, 3000);

    processToStop.once('exit', async () => {
      clearTimeout(timer);
      resolve(getHelperStatus());
    });

    processToStop.kill('SIGTERM');
  });
}

ipcMain.handle('helper:get-status', async () => {
  const status = await getHelperStatus();
  await updateTrayMenu();
  return status;
});

ipcMain.handle('helper:start', async () => {
  const status = await startHelper();
  await updateTrayMenu();
  return status;
});

ipcMain.handle('helper:stop', async () => {
  const status = await stopHelper();
  await updateTrayMenu();
  return status;
});

ipcMain.handle('helper:open-logs', async () => {
  return shell.showItemInFolder(getLogPath());
});

app.whenReady().then(() => {
  createTray();
  createWindow();

  app.on('activate', () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    showWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  isQuitting = true;
  await stopHelper();
});
