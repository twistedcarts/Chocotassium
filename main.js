const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const find = require('find-process');
const fs = require('fs');
const path = require('path');
let remote;
try {
  remote = require('@electron/remote/main');
  remote.initialize();
} catch (e) {}

let win;
let clients = [];
let attaching = false;
let auto_attach_int = null;
let settings = { auto_attach: false };

const set_path = app.isPackaged 
  ? path.join(app.getPath('userData'), 'settings.json')
  : path.join(__dirname, 'settings.json');

function load_set() {
  try {
    if (fs.existsSync(set_path)) {
      const data = fs.readFileSync(set_path, 'utf-8');
      settings = { ...settings, ...JSON.parse(data) };
    }
  } catch (err) {}
}

load_set();

fs.watchFile(set_path, () => {
  load_set();
  update_auto_attach();
});

function update_auto_attach() {
  if (settings.auto_attach) start_auto_attach();
  else stop_auto_attach();
}
// hyperion::chocosploit_detection?
function start_auto_attach() {
  if (auto_attach_int) return;

  auto_attach_int = setInterval(async () => {
    if (clients.length > 0) return;

    try {
      const inj_check = await find.default('name', 'Injector.exe');
      if (inj_check.length > 0) return;

      const roblox_procs = await find.default('name', 'RobloxPlayerBeta.exe');
      if (roblox_procs.length > 0) {
        const pid = roblox_procs[0].pid;
        const inj_path = app.isPackaged 
          ? path.join(process.resourcesPath, "..", "Injector.exe")
          : path.join(__dirname, "Injector.exe");

        if (fs.existsSync(inj_path)) {
          spawn('cmd.exe', ['/c', 'start', '""', inj_path, pid.toString()], {
            detached: true,
            windowsHide: false
          });

          if (win) {
            win.webContents.send("on_log", `Auto-attaching to Roblox (PID: ${pid})...`, "info");
          }
        }
      }
    } catch (err) {}
  }, 3000);
}

function stop_auto_attach() {
  if (auto_attach_int) {
    clearInterval(auto_attach_int);
    auto_attach_int = null;
  }
}

const ws_server = new WebSocketServer({ port: 6969 });

ws_server.on("connection", (ws) => {
  clients.push(ws);
  win.webContents.send("attached", true);

  ws.on("close", () => {
    const idx = clients.indexOf(ws);
    if (idx !== -1) {
      win.webContents.send("attached", false);
      clients.splice(idx, 1);
    }
  });

  ws.on("message", (msg) => {
    const [type, content] = msg.toString().split("|");
    win.webContents.send("on_log", content, type);
  });
});
// free diddy twin aint did shit
function create_win() {
  const win_obj = new BrowserWindow({
    width: 800, height: 450, minWidth: 700, minHeight: 400,
    backgroundColor: '#00000000', frame: false, transparent: true,
    hasShadow: true, resizable: true,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false,
      enableRemoteModule: true, spellcheck: false
    }
  });

  win = win_obj;

  if (remote) remote.enable(win.webContents);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.control || input.meta) {
      if (input.key.toLowerCase() === 'c' && input.type === 'keyDown') win.webContents.copy();
      else if (input.key.toLowerCase() === 'x' && input.type === 'keyDown') win.webContents.cut();
      else if (input.key.toLowerCase() === 'v' && input.type === 'keyDown') win.webContents.paste();
      else if (input.key.toLowerCase() === 'a' && input.type === 'keyDown') win.webContents.selectAll();
    }
  });

  win.webContents.on('context-menu', (e, params) => {
    const { selectionText, isEditable } = params;
    if (isEditable) {
      Menu.buildFromTemplate([
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' },
        { type: 'separator' }, { role: 'selectAll' }
      ]).popup();
    } else if (selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup();
    }
  });

  win_obj.loadFile('index.html');

  setTimeout(() => {
    win_obj.webContents.send("on_log", "Websocket server started at localhost:6969", "info");
    update_auto_attach(); 
  }, 500);
}

ipcMain.on("attach", async (event) => {
  if (attaching) {
    win.webContents.send("on_log", "Already attempting to attach...", "warn");
    return;
  }

  attaching = true;

  const inj_path = app.isPackaged 
    ? path.join(process.resourcesPath, "..", "Injector.exe")
    : path.join(__dirname, "Injector.exe");
    
  if (!fs.existsSync(inj_path)) {
    win.webContents.send("on_log", "Injector is not present in directory!", "error");
    attaching = false;
    return;
  }

  try {
    const procs = await find.default('name', 'RobloxPlayerBeta.exe');
    if (procs.length > 0) {
      const pid = procs[0].pid;
      spawn('cmd.exe', ['/c', 'start', '""', inj_path, pid.toString()], {
        detached: true, windowsHide: false
      });
      win.webContents.send("on_log", `Injecting into Roblox process (PID: ${pid})...`, "info");
    } else {
      win.webContents.send("on_log", "Roblox isn't open.", "error");
    }
  } catch (err) {
    win.webContents.send("on_log", "An error occurred while finding the process.", "error");
  } finally {
    setTimeout(() => { attaching = false; }, 2000);
  }
});

ipcMain.on("execute", (event, script) => {
  if (clients.length === 0) {
    win.webContents.send("on_log", "No clients attached. Please attach first.", "error");
    return;
  }

  let executed = false;
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(script);
      executed = true;
    }
  });

  if (executed) win.webContents.send("on_log", "Script executed successfully!", "info");
  else win.webContents.send("on_log", "Failed to execute script - no active connections.", "error");
});
// lock up jaydes
app.whenReady().then(create_win);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stop_auto_attach();
  if (set_path && fs.existsSync(set_path)) fs.unwatchFile(set_path);
  ws_server.close();
});