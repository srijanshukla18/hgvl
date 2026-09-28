// herdr-hands main process: owns the overlay window, the menu-bar item, the
// Herdr connection and the speech worker. The overlay renderer owns the
// camera, the gesture engine and all drawing.

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, screen, session, systemPreferences, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Intent, IntentResult, LayoutSnapshot, OverlayConfig, PaneView, Rect } from '../shared/types.ts';
import { configPath, loadConfig, type KeyMap } from './config.ts';
import { HerdrClient } from './herdr.ts';
import { MockHerdr } from './mock.ts';
import { DEFAULT_KEYS, type HerdrModel, type HerdrSource } from './model.ts';
import { Speech } from './stt.ts';
import { findTerminalApp, frontWindowBounds } from './window-bounds.ts';

const ROOT = app.getAppPath();
const cfg = loadConfig();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Keep the camera loop at full rate even though the overlay never has focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.platform === 'darwin') app.dock?.hide();

let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let herdr: HerdrSource;
let speech: Speech;
let enabled = true;
let showCamera = cfg.showCamera;
let terminal: { app: string; pid?: number } | null = null;
let termBounds: Rect | null = null;
let lastLayoutJson = '';

function log(...args: unknown[]): void {
  console.log('[hands]', ...args);
}

// ---- static files over app:// ------------------------------------------------------

function serveApp(): void {
  const roots: Record<string, string> = {
    wasm: join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
    models: join(ROOT, 'models'),
  };
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    const parts = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
    const base = roots[parts[0]] ? roots[parts.shift()!] : join(ROOT, 'dist', 'renderer');
    const file = normalize(join(base, ...parts));
    if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---- overlay window --------------------------------------------------------------------

function createOverlay(): BrowserWindow {
  const d = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...d.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: join(ROOT, 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL('app://hands/index.html');
  win.webContents.on('console-message', (e) => {
    const { level, message } = e as unknown as { level: string; message: string };
    if (level === 'error' || level === 'warning') log(`renderer ${level}: ${message}`);
  });
  if (process.env.HANDS_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

/** Move the overlay onto the display that shows the terminal. */
function placeOverlay(): Rect {
  const target = termBounds
    ? screen.getDisplayMatching({ x: termBounds.x, y: termBounds.y, width: termBounds.w, height: termBounds.h })
    : screen.getPrimaryDisplay();
  const b = target.bounds;
  if (overlay) {
    const cur = overlay.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) overlay.setBounds(b);
  }
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

// ---- herdr → overlay layout ------------------------------------------------------------------

function computeLayout(model: HerdrModel): LayoutSnapshot {
  const disp = placeOverlay();
  let frame: Rect;
  if (termBounds) {
    const fullscreen = termBounds.w >= disp.w - 2 && termBounds.h >= disp.h - 2;
    const ins = cfg.frameInsets;
    const top = ins.top === 'auto' ? (fullscreen ? 0 : 28) : ins.top;
    frame = {
      x: termBounds.x - disp.x + ins.left,
      y: termBounds.y - disp.y + top,
      w: termBounds.w - ins.left - ins.right,
      h: termBounds.h - top - ins.bottom,
    };
  } else {
    frame = { x: 0, y: 0, w: disp.w, h: disp.h };
  }
  const cw = frame.w / Math.max(1, model.cols);
  const ch = frame.h / Math.max(1, model.rows);
  const panes: PaneView[] = model.panes.map((p) => {
    const tail = (p.tail ?? '').toLowerCase();
    return {
      id: p.id,
      agent: p.agent,
      label: p.label,
      state: p.state,
      focused: p.focused,
      rect: { x: frame.x + p.cells.x * cw, y: frame.y + p.cells.y * ch, w: p.cells.w * cw, h: p.cells.h * ch },
      danger: p.state === 'blocked' ? (cfg.dangerList.find((d) => tail.includes(d.toLowerCase())) ?? null) : null,
    };
  });
  return { connected: model.connected, frame, panes, zoomedPaneId: model.zoomedPaneId, error: model.error };
}

function pushLayout(): void {
  if (!overlay || !herdr) return;
  const layout = computeLayout(herdr.model);
  const json = JSON.stringify(layout);
  if (json === lastLayoutJson) return;
  lastLayoutJson = json;
  overlay.webContents.send('layout', layout);
}

async function trackTerminalWindow(): Promise<void> {
  if (process.platform !== 'darwin' || cfg.mock) return;
  try {
    if (!terminal) {
      terminal = cfg.terminalApp !== 'auto' ? { app: cfg.terminalApp } : await findTerminalApp();
      if (terminal) log(`herdr is shown in ${terminal.app}`);
    }
    if (terminal) {
      const w = await frontWindowBounds(terminal);
      if (w) termBounds = w.bounds;
      else if (cfg.terminalApp === 'auto') terminal = null; // app quit or herdr moved: search again
    }
  } catch (err) {
    log('window tracking failed', String(err));
  }
  pushLayout();
}

// ---- intents -------------------------------------------------------------------------------------

function keysFor(paneId: string): KeyMap {
  const agent = herdr.model.panes.find((p) => p.id === paneId)?.agent ?? 'default';
  return { ...(DEFAULT_KEYS[agent] ?? DEFAULT_KEYS.default), ...(cfg.agents[agent] ?? {}) };
}

async function runIntent(intent: Intent): Promise<IntentResult> {
  log('intent', JSON.stringify(intent));
  try {
    switch (intent.kind) {
      case 'approve':
        return await herdr.approve(intent.paneId, keysFor(intent.paneId));
      case 'deny':
        return await herdr.deny(intent.paneId, keysFor(intent.paneId));
      case 'interrupt':
        return await herdr.interrupt(intent.paneId, keysFor(intent.paneId));
      case 'zoom':
        return await herdr.zoom(intent.paneId);
      case 'focus':
        return await herdr.focus(intent.paneId);
      case 'prompt':
        return await herdr.prompt(intent.paneId, intent.text);
    }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

// ---- menu bar ----------------------------------------------------------------------------------------

function setEnabled(on: boolean): void {
  enabled = on;
  overlay?.webContents.send('toggle', on);
  rebuildMenu();
}

function rebuildMenu(): void {
  if (!tray) return;
  tray.setTitle(enabled ? '✋' : '✋̸');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: enabled ? 'Hands on' : 'Hands off', type: 'checkbox', checked: enabled, accelerator: 'CommandOrControl+Shift+H', click: () => setEnabled(!enabled) },
      {
        label: 'Camera preview',
        type: 'checkbox',
        checked: showCamera,
        click: () => {
          showCamera = !showCamera;
          overlay?.webContents.executeJavaScript(`document.getElementById('pip').classList.toggle('hidden', ${!showCamera})`);
          rebuildMenu();
        },
      },
      { label: 'Gesture legend', type: 'checkbox', click: (i) => overlay?.webContents.executeJavaScript(`document.getElementById('legend').classList.toggle('hidden', ${!i.checked})`) },
      { type: 'separator' },
      { label: cfg.mock ? 'Source: mock herdr' : `Source: herdr${herdr?.model.connected ? '' : ' (not connected)'}`, enabled: false },
      { label: terminal ? `Terminal: ${terminal.app}` : 'Terminal: whole screen', enabled: false },
      { label: `Config: ${configPath}`, enabled: false },
      { type: 'separator' },
      { label: 'Reload overlay', click: () => overlay?.webContents.reload() },
      { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]),
  );
}

// ---- boot ------------------------------------------------------------------------------------------------

app.whenReady().then(async () => {
  serveApp();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera').catch(() => false);
    await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  }

  if (!existsSync(join(ROOT, 'models', 'gesture_recognizer.task'))) {
    log('models/gesture_recognizer.task is missing — run `npm run models` first');
  }

  herdr = cfg.mock ? new MockHerdr() : new HerdrClient(cfg);
  herdr.on('change', () => {
    pushLayout();
    rebuildMenu();
  });

  speech = new Speech(cfg, (e) => overlay?.webContents.send('speech', e));
  speech.start();

  overlay = createOverlay();
  overlay.webContents.on('did-finish-load', () => {
    lastLayoutJson = '';
    pushLayout();
  });
  screen.on('display-metrics-changed', () => pushLayout());

  ipcMain.handle('config', (): OverlayConfig => ({
    showCamera: cfg.showCamera,
    sounds: cfg.sounds,
    dangerList: cfg.dangerList,
    pointerGain: cfg.pointerGain,
    mirror: cfg.mirror,
    visionDelegate: cfg.visionDelegate,
  }));
  ipcMain.handle('intent', (_e, intent: Intent) => runIntent(intent));
  ipcMain.on('speech:start', (_e, id: number) => speech.begin(id));
  ipcMain.on('speech:chunk', (_e, id: number, samples: Float32Array) => speech.push(id, samples));
  ipcMain.on('speech:end', (_e, id: number, cancel: boolean) => speech.end(id, cancel));
  ipcMain.on('log', (_e, line: string) => log(line));

  try {
    tray = new Tray(nativeImage.createEmpty());
  } catch (err) {
    log('no tray available', String(err));
  }
  rebuildMenu();
  globalShortcut.register('CommandOrControl+Shift+H', () => setEnabled(!enabled));

  herdr.start();
  void trackTerminalWindow();
  setInterval(() => void trackTerminalWindow(), 1000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  herdr?.stop();
  speech?.stop();
});
app.on('window-all-closed', () => app.quit());
