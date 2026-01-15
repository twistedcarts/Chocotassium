const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');
const find = require('find-process');
const fs = require('fs');
const path = require('path');
let remote;
try {
  remote = require('@electron/remote/main');
  remote.initialize();
} catch (e) {}

let win;
let instance_manager_win = null;
let clients = [];
let attaching = false;
let auto_attach_int = null;
let settings = { auto_attach: false, show_instance_manager: false };
let next_client_id = 1;
let pending_injection_pid = null;
let selected_client_ids = [];

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
            win.webContents.send("onLog", `Auto-attaching to Roblox (PID: ${pid})...`, "info");
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

ws_server.on("connection", (ws, req) => {
  const client_pid = pending_injection_pid;
  pending_injection_pid = null;
  
  const client_info = { ws, pid: client_pid, clientId: next_client_id++ };
  clients.push(client_info);
  
  win.webContents.send("attached", true);
  broadcast_instances();

  ws.on("close", () => {
    const idx = clients.findIndex(c => c.ws === ws);
    if (idx !== -1) {
      clients.splice(idx, 1);
      if (clients.length === 0) {
        win.webContents.send("attached", false);
      }
      broadcast_instances();
    }
  });

  ws.on("message", (msg) => {
    const message = msg.toString();
    const first_pipe = message.indexOf("|");
    
    if (message.startsWith("PID|")) {
      const pid = parseInt(message.substring(4));
      if (!isNaN(pid)) {
        client_info.pid = pid;
        broadcast_instances();
      }
      return;
    }
    
    if (first_pipe === -1) {
      win.webContents.send("onLog", message, "info");
    } else {
      const type = message.substring(0, first_pipe).toLowerCase();
      const content = message.substring(first_pipe + 1);
      win.webContents.send("onLog", content, type);
    }
  });
});

async function broadcast_instances() {
  try {
    const roblox_procs = await find.default('name', 'RobloxPlayerBeta.exe');
    
    const injected_pids = clients.filter(c => c.pid).map(c => c.pid);
    
    const instances = roblox_procs.map(proc => {
      const injected_client = clients.find(c => c.pid === proc.pid);
      return {
        pid: proc.pid,
        name: proc.name,
        injected: !!injected_client,
        clientId: injected_client ? injected_client.clientId : null
      };
    });
    
    if (win && !win.isDestroyed()) {
      win.webContents.send('instances-updated', instances, clients.length);
    }
    if (instance_manager_win && !instance_manager_win.isDestroyed()) {
      instance_manager_win.webContents.send('instances-updated', instances, clients.length);
    }
  } catch (err) {
    console.error(err);
  }
}

// free diddy twin aint did shit
function create_win() {
  const win_obj = new BrowserWindow({
    width: 800, height: 450, minWidth: 700, minHeight: 400,
    backgroundColor: '#00000000', frame: false, transparent: true,
    hasShadow: true, resizable: true,
    icon: path.join(__dirname, 'icon.png'),
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
    const { selectionText: selection_text, isEditable: is_editable } = params;
    if (is_editable) {
      Menu.buildFromTemplate([
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' },
        { type: 'separator' }, { role: 'selectAll' }
      ]).popup();
    } else if (selection_text) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup();
    }
  });

  win_obj.loadFile('index.html');

  setTimeout(() => {
    update_auto_attach(); 
  }, 500);
}

ipcMain.on("attach", async (event) => {
  if (attaching) {
    win.webContents.send("onLog", "Already attempting to attach...", "warn");
    return;
  }

  attaching = true;

  const inj_path = app.isPackaged 
    ? path.join(process.resourcesPath, "..", "Injector.exe")
    : path.join(__dirname, "Injector.exe");
    
  if (!fs.existsSync(inj_path)) {
    win.webContents.send("onLog", "Injector is not present in directory!", "error");
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
      win.webContents.send("onLog", `Injecting into Roblox process (PID: ${pid})...`, "info");
    } else {
      win.webContents.send("onLog", "Roblox isn't open.", "error");
    }
  } catch (err) {
    win.webContents.send("onLog", "An error occurred while finding the process.", "error");
  } finally {
    setTimeout(() => { attaching = false; }, 2000);
  }
});

ipcMain.on("execute", (event, script, target_client_id = null) => {
  if (clients.length === 0) {
    win.webContents.send("onLog", "No clients attached. Please attach first.", "error");
    return;
  }

  const has_selection = selected_client_ids.length > 0;

  let executed = 0;
  clients.forEach((client_info) => {
    if (target_client_id && client_info.clientId !== target_client_id) return;
    if (!target_client_id && has_selection && !selected_client_ids.includes(client_info.clientId)) return;
    
    if (client_info.ws.readyState === client_info.ws.OPEN) {
      client_info.ws.send(script);
      executed++;
    }
  });
  
  if (executed > 0) {
    win.webContents.send("onLog", `Script executed on ${executed} client(s)`, "success");
  }
});

ipcMain.on('set-selected-clients', (event, client_ids) => {
  selected_client_ids = client_ids || [];
  
  if (win && !win.isDestroyed()) {
    win.webContents.send('selected-clients-changed', selected_client_ids);
  }
});

ipcMain.on('set-selected-client', (event, client_id) => {
  selected_client_ids = client_id ? [client_id] : [];
  
  if (win && !win.isDestroyed()) {
    win.webContents.send('selected-clients-changed', selected_client_ids);
  }
});

ipcMain.on('set-reg-key', (event, key, name, value) => {
  const finalPath = `HKEY_CURRENT_USER\\${key}`;
  const dword = value ? 1 : 0;

  const command = `reg add "${finalPath}" /v "${name}" /t REG_DWORD /d ${dword} /f`;
  exec(command, (err) => {
    if (err) {
      event.reply('onLog', 'Failed to update registry.', 'error');
      return;
    }
  });
});

ipcMain.on('toggle-instance-manager', (event, show) => {
  if (show) {
    create_instance_manager();
  } else {
    if (instance_manager_win && !instance_manager_win.isDestroyed()) {
      instance_manager_win.close();
      instance_manager_win = null;
    }
  }
});

ipcMain.on('get-instances', async (event) => {
  await broadcast_instances();
});

ipcMain.on('inject-to-pid', async (event, pid) => {
  if (attaching) {
    win.webContents.send("onLog", "Already attempting to attach...", "warn");
    return;
  }
  
  const already_injected = clients.find(c => c.pid === pid);
  if (already_injected) {
    win.webContents.send("onLog", `Already injected to PID ${pid}`, "warn");
    return;
  }

  attaching = true;
  pending_injection_pid = pid;

  const inj_path = app.isPackaged 
    ? path.join(process.resourcesPath, "..", "Injector.exe")
    : path.join(__dirname, "Injector.exe");
    
  if (!fs.existsSync(inj_path)) {
    win.webContents.send("onLog", "Injector is not present in directory!", "error");
    attaching = false;
    pending_injection_pid = null;
    return;
  }

  try {
    spawn('cmd.exe', ['/c', 'start', '""', inj_path, pid.toString()], {
      detached: true, windowsHide: false
    });
    win.webContents.send("onLog", `Injecting into Roblox process (PID: ${pid})...`, "info");
  } catch (err) {
    win.webContents.send("onLog", "An error occurred while injecting.", "error");
    pending_injection_pid = null;
  } finally {
    setTimeout(() => { attaching = false; }, 2000);
  }
});

ipcMain.on('execute-on-client', (event, client_id, script) => {
  if (clients.length === 0) return;
  if (!script) {
    win.webContents.send('request-execute-on-client', client_id);
    return;
  }

  clients.forEach((client_info) => {
    if (client_info.clientId !== client_id) return;
    if (client_info.ws.readyState === client_info.ws.OPEN) {
      client_info.ws.send(script);
    }
  });
});

ipcMain.on('execute-all-injected', (event, script) => {
  if (clients.length === 0) return;
  if (!script) {
    win.webContents.send('request-execute-all');
    return;
  }
  clients.forEach((client_info) => {
    if (client_info.ws.readyState === client_info.ws.OPEN) {
      client_info.ws.send(script);
    }
  });
});

ipcMain.on('get-script-for-execution', (event, client_id) => {
  win.webContents.send('get-script-for-client', client_id);
});

ipcMain.on('get-script-for-execution-all', (event) => {
  win.webContents.send('get-script-for-all');
});

ipcMain.on('execute-script-on-client', (event, client_id, script) => {
  if (!script) return;
  clients.forEach((client_info) => {
    if (client_info.clientId !== client_id) return;
    if (client_info.ws.readyState === client_info.ws.OPEN) {
      client_info.ws.send(script);
    }
  });
});

ipcMain.on('execute-script-on-all', (event, script) => {
  if (!script) return;
  clients.forEach((client_info) => {
    if (client_info.ws.readyState === client_info.ws.OPEN) {
      client_info.ws.send(script);
    }
  });
});

function create_instance_manager() {
  if (instance_manager_win && !instance_manager_win.isDestroyed()) {
    instance_manager_win.focus();
    return;
  }

  const main_bounds = win.getBounds();
  const manager_width = 280;

  instance_manager_win = new BrowserWindow({
    width: manager_width,
    height: main_bounds.height,
    x: main_bounds.x + main_bounds.width,
    y: main_bounds.y,
    backgroundColor: '#00000000',
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    alwaysOnTop: win.isAlwaysOnTop(),
    skipTaskbar: true,
    parent: win,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  if (remote) remote.enable(instance_manager_win.webContents);

  instance_manager_win.loadFile('instance-manager.html');

  const update_position = () => {
    if (instance_manager_win && !instance_manager_win.isDestroyed() && win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      instance_manager_win.setBounds({
        x: bounds.x + bounds.width,
        y: bounds.y,
        width: manager_width,
        height: bounds.height
      });
    }
  };

  win.on('move', update_position);
  win.on('resize', update_position);
  win.on('always-on-top-changed', (event, is_always_on_top) => {
    if (instance_manager_win && !instance_manager_win.isDestroyed()) {
      instance_manager_win.setAlwaysOnTop(is_always_on_top);
    }
  });

  instance_manager_win.on('closed', () => {
    instance_manager_win = null;
    selected_client_ids = [];
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('instance-manager-closed');
      win.webContents.send('selected-clients-changed', []);
    }
  });

  setTimeout(() => broadcast_instances(), 500);
}

setInterval(() => {
  if (win && !win.isDestroyed()) {
    broadcast_instances();
  }
}, 5000);

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