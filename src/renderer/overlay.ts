// Overlay controller: wires camera → engine → Herdr intents, the mic → speech
// worker, and keeps the HUD, talk card and canvas effects in sync.

import { GestureEngine, type EngineEvent, type EngineView } from '../engine/engine.ts';
import type { HandsBridge, Intent, LayoutSnapshot, PaneView, Route, SpeechEvent } from '../shared/types.ts';
import { Mic } from './audio.ts';
import { Fx, type BurstKind } from './fx.ts';
import { drawSkeleton } from './skeleton.ts';
import { Sounds } from './sounds.ts';
import { Vision } from './vision.ts';

declare global {
  interface Window {
    hands: HandsBridge;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const bridge = window.hands;

const fx = new Fx($('fx') as HTMLCanvasElement);
const vision = new Vision($('cam') as HTMLVideoElement);
const mic = new Mic();
const sounds = new Sounds();
let engine = new GestureEngine();

let layout: LayoutSnapshot = { connected: false, frame: { x: 0, y: 0, w: innerWidth, h: innerHeight }, panes: [] };
let view: EngineView | null = null;
let enabled = true;
let showCamera = true;
let jevOn = false;
let micCloseTimer: number | undefined;
let fps = 0;

// ---- talk / send state -----------------------------------------------------------

interface Utterance {
  id: number;
  /** The agent pointed at when the pinch started; null when talking to herdr as a whole (Jev only). */
  paneId: string | null;
  text: string;
  final: boolean;
  /** What 👍 will do, once decided. */
  route: Route | null;
  /** Unconfirmed transcripts are dropped at this time (performance.now()). */
  expiresAt: number | null;
}

/** A transcript waits this long for 👍 / 👎 before it is quietly dropped. */
const CONFIRM_TIMEOUT_MS = 20000;
let utterId = 0;
let utter: Utterance | null = null;

const talkEl = $('talk');
const talkText = $('talk-text');
const talkTarget = $('talk-target');
const talkConfirm = $('talk-confirm');
const waveCanvas = $('talk-wave') as HTMLCanvasElement;

// ---- boot -------------------------------------------------------------------------

async function boot(): Promise<void> {
  const cfg = await bridge.config();
  sounds.enabled = cfg.sounds;
  showCamera = cfg.showCamera;
  jevOn = cfg.jev;
  engine = new GestureEngine({
    gain: cfg.pointerGain,
    centerX: cfg.pointerCenter[0],
    centerY: cfg.pointerCenter[1],
    mirror: cfg.mirror,
  });

  bridge.onLayout((l) => {
    layout = l;
    fx.layout = l;
    const root = document.documentElement.style;
    root.setProperty('--frame-right', `${Math.max(0, innerWidth - (l.frame.x + l.frame.w))}px`);
    root.setProperty('--frame-bottom', `${Math.max(0, innerHeight - (l.frame.y + l.frame.h))}px`);
    renderHud();
  });
  bridge.onSpeech(onSpeech);
  bridge.onToggle((on) => setEnabled(on));

  hud('starting camera…', 'idle', true);
  try {
    await vision.init(cfg.visionDelegate);
    await vision.start(onFrame);
    bridge.log(`vision ready (${vision.delegate})`);
  } catch (err) {
    bridge.log('vision failed', String(err));
    hud(`camera unavailable: ${String((err as Error)?.message ?? err)}`, 'error', true);
  }
  $('pip').classList.toggle('hidden', !showCamera);
  requestAnimationFrame(loop);
}

function setEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
    vision.stop();
    mic.close();
    abortUtterance(false);
    view = null;
    fx.view = null;
    $('pip').classList.add('hidden');
    hud('hands off', 'idle', true);
    setTimeout(() => !enabled && hud('', 'idle', false), 1200);
  } else {
    void vision.start(onFrame).then(() => $('pip').classList.toggle('hidden', !showCamera));
    renderHud();
  }
}

// ---- per camera frame ------------------------------------------------------------------

let lastFrameT = 0;
function onFrame(f: { hand: import('../engine/features.ts').HandFrame | null; t: number }): void {
  if (!enabled) return;
  if (lastFrameT) fps = fps * 0.9 + (1000 / Math.max(1, f.t - lastFrameT)) * 0.1;
  lastFrameT = f.t;
  const r = engine.update(f.hand, f.t, { panes: layout.panes, frame: layout.frame, pendingSend: utter !== null && !view?.talking });
  view = r.view;
  fx.view = r.view;
  for (const e of r.events) void handle(e);
  if (showCamera) {
    drawSkeleton($('skeleton') as HTMLCanvasElement, vision.video, f.hand, r.view.armed ? '#38e1ff' : 'rgba(255,255,255,0.6)');
    $('pip').classList.toggle('live', r.view.armed);
    $('pip-label').textContent = r.view.armed ? poseLabel(r.view) : '';
  }
  renderHud();
}

async function handle(e: EngineEvent): Promise<void> {
  switch (e.type) {
    case 'arm':
      sounds.play('arm');
      clearTimeout(micCloseTimer);
      mic.ensureOpen().catch((err) => bridge.log('mic failed', String(err)));
      break;
    case 'disarm':
      clearTimeout(micCloseTimer);
      micCloseTimer = window.setTimeout(() => !view?.armed && mic.close(), 8000);
      break;
    case 'approve':
      await act({ kind: 'approve', paneId: e.paneId }, 'approve', `Approved ${name(e.paneId)}`);
      break;
    case 'deny':
      if (e.paneId) {
        await act({ kind: 'deny', paneId: e.paneId }, 'deny', `Denied ${name(e.paneId)}`);
      } else {
        toast(nobodyBlocked());
      }
      break;
    case 'interrupt':
      await act({ kind: 'interrupt', paneId: e.paneId }, 'stop', `Stopped ${name(e.paneId)}`);
      break;
    case 'send':
      if (!utter) break;
      if (!utter.route) toast('Still working it out — 👍 again once the card says what it will do');
      else await commitUtterance(utter);
      break;
    case 'cancel':
      abortUtterance(true);
      break;
    case 'talkStart':
      startUtterance(e.paneId, e.preRollMs);
      break;
    case 'talkEnd':
      endUtterance();
      break;
    case 'hint':
      toast(e.text);
      sounds.play('cancel');
      break;
  }
}

async function act(
  intent: Extract<Intent, { paneId: string }>,
  burst: BurstKind,
  message: string | null,
): Promise<boolean> {
  fx.burst(burst, intent.paneId);
  sounds.play(burst === 'stop' ? 'stop' : burst === 'deny' ? 'deny' : 'approve');
  const res = await bridge.intent(intent);
  if (!res.ok) {
    toast(`⚠︎ ${res.error ?? 'herdr refused'}`);
    return false;
  }
  if (message) toast(message);
  return true;
}

// ---- voice ---------------------------------------------------------------------------------

function startUtterance(paneId: string | null, preRollMs: number): void {
  // Dictation types into the pane and presses Enter: only ever do that to an agent, never a shell.
  const agent = layout.panes.find((p) => p.id === paneId && p.agent);
  // With Jev you can talk without pointing: it works out the agent, tab or workspace you mean.
  if (!agent && !jevOn) {
    toast(paneId ? `${name(paneId)} isn't an agent — point at one to talk` : 'Point at an agent, then pinch and hold to talk');
    sounds.play('cancel');
    return;
  }
  abortUtterance(false);
  const id = ++utterId;
  utter = { id, paneId: agent?.id ?? null, text: '', final: false, route: null, expiresAt: null };
  talkTarget.textContent = agent ? agent.label : 'herdr';
  talkText.innerHTML = '<span class="placeholder">listening…</span>';
  talkConfirm.textContent = '';
  talkEl.classList.remove('hidden', 'leaving', 'cancelled', 'confirm');
  fx.talkPaneId = agent?.id ?? null;
  sounds.play('talk');
  bridge.speechStart(id);
  mic
    .ensureOpen()
    .then(() => {
      if (utter?.id === id) mic.begin(preRollMs, (chunk) => bridge.speechChunk(id, chunk));
    })
    .catch((err) => {
      toast(`microphone unavailable: ${String(err)}`);
      abortUtterance(false);
    });
}

function endUtterance(): void {
  mic.end();
  if (!utter) return;
  bridge.speechEnd(utter.id, false);
  if (!utter.text) talkText.innerHTML = '<span class="placeholder">transcribing…</span>';
}

function abortUtterance(withFx: boolean): void {
  if (!utter) return;
  mic.end();
  bridge.speechEnd(utter.id, true);
  if (withFx) {
    fx.burst('cancel', null, cardCenter());
    sounds.play('cancel');
    toast('Cancelled');
    talkEl.classList.remove('confirm');
    talkEl.classList.add('cancelled');
    const el = talkEl;
    setTimeout(() => el.classList.add('hidden'), 400);
  } else {
    talkEl.classList.add('hidden');
  }
  utter = null;
  fx.talkPaneId = null;
}

function onSpeech(e: SpeechEvent): void {
  if (e.kind === 'ready') {
    bridge.log(`speech model ready: ${e.model}`);
    return;
  }
  if (e.kind === 'error') {
    toast(`speech: ${e.message}`);
    if (utter && !view?.talking) abortUtterance(false);
    return;
  }
  if (!utter || e.id !== utter.id || utter.final) return;
  utter.text = e.text.trim();
  if (e.kind === 'partial') {
    if (utter.text) talkText.innerHTML = `<span class="partial">${escapeHtml(utter.text)}</span>`;
    return;
  }
  // Final transcript.
  utter.final = true;
  bridge.log(`transcript (${e.ms} ms): ${utter.text}`);
  if (!utter.text) {
    talkText.innerHTML = '<span class="placeholder">didn’t catch that</span>';
    const u = utter;
    setTimeout(() => utter === u && abortUtterance(false), 900);
    return;
  }
  talkText.textContent = utter.text;
  talkConfirm.textContent = jevOn ? 'deciding…' : '';
  void routeUtterance(utter);
}

/** Work out what the words should do, then wait for 👍 / 👎. */
async function routeUtterance(u: Utterance): Promise<void> {
  let route: Route;
  try {
    route = await bridge.route({ text: u.text, paneId: u.paneId });
  } catch (err) {
    route = { kind: 'none', reason: `couldn't route: ${String(err)}` };
  }
  if (utter !== u) return;
  if (route.kind === 'none') {
    talkConfirm.textContent = route.reason;
    sounds.play('cancel');
    setTimeout(() => utter === u && abortUtterance(false), 1800);
    return;
  }
  u.route = route;
  if ('paneId' in route) {
    talkTarget.textContent = name(route.paneId);
    fx.talkPaneId = route.paneId;
  }
  talkConfirm.textContent = `👍 ${describe(route)}   ·   👎 cancel`;
  talkEl.classList.add('confirm');
  u.expiresAt = performance.now() + CONFIRM_TIMEOUT_MS;
}

function describe(r: Exclude<Route, { kind: 'none' }>): string {
  switch (r.kind) {
    case 'prompt':
      return `send to ${name(r.paneId)}`;
    case 'approve':
      return `approve ${name(r.paneId)}`;
    case 'deny':
      return `deny ${name(r.paneId)}`;
    case 'interrupt':
      return `stop ${name(r.paneId)}`;
    case 'focusTab':
      return `go to tab ${r.label}`;
    case 'focusWorkspace':
      return `go to workspace ${r.label}`;
  }
}

async function commitUtterance(u: Utterance): Promise<void> {
  const route = u.route;
  if (!route || route.kind === 'none') return;
  const from = cardCenter();
  talkEl.classList.add('leaving');
  setTimeout(() => talkEl.classList.add('hidden'), 260);
  utter = null;
  fx.talkPaneId = null;

  switch (route.kind) {
    case 'approve':
      await act({ kind: 'approve', paneId: route.paneId }, 'approve', `Approved ${name(route.paneId)}`);
      return;
    case 'deny':
      await act({ kind: 'deny', paneId: route.paneId }, 'deny', `Denied ${name(route.paneId)}`);
      return;
    case 'interrupt':
      await act({ kind: 'interrupt', paneId: route.paneId }, 'stop', `Stopped ${name(route.paneId)}`);
      return;
    case 'focusTab':
    case 'focusWorkspace': {
      sounds.play('send');
      const res = await bridge.intent(
        route.kind === 'focusTab' ? { kind: 'focusTab', tabId: route.tabId } : { kind: 'focusWorkspace', workspaceId: route.workspaceId },
      );
      toast(res.ok ? describe(route).replace(/^go to/, 'Went to') : `⚠︎ ${res.error ?? 'herdr refused'}`);
      return;
    }
    case 'prompt': {
      fx.comet(from, route.paneId);
      sounds.play('send');
      const res = await bridge.intent({ kind: 'prompt', paneId: route.paneId, text: u.text });
      toast(res.ok ? `Sent to ${name(route.paneId)}` : `⚠︎ ${res.error ?? 'could not send'}`);
      return;
    }
  }
}

function cardCenter(): { x: number; y: number } {
  const r = talkEl.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function placeCard(): void {
  if (!utter) return;
  const route = utter.route;
  const id = route && 'paneId' in route ? route.paneId : utter.paneId;
  const pane = layout.panes.find((p) => p.id === id);
  const r = pane?.rect ?? layout.frame;
  const w = talkEl.offsetWidth;
  const h = talkEl.offsetHeight;
  const x = Math.min(innerWidth - w - 16, Math.max(16, r.x + r.w / 2 - w / 2));
  const y = Math.min(innerHeight - h - 16, Math.max(16, r.y + r.h * 0.78 - h));
  talkEl.style.left = `${x}px`;
  talkEl.style.top = `${y}px`;
}

function drawWave(): void {
  const ctx = waveCanvas.getContext('2d')!;
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = mic.levels.length;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0.06, Math.min(1, mic.levels[i] * 1.6));
    const bh = v * h;
    ctx.fillStyle = `rgba(167,139,250,${0.35 + 0.65 * (i / n)})`;
    ctx.fillRect(i * bw + 1, (h - bh) / 2, Math.max(1, bw - 2), bh);
  }
}

// ---- render loop -----------------------------------------------------------------------------

function loop(now: number): void {
  fx.talkLevel = mic.level;
  fx.draw(now);
  if (utter) {
    placeCard();
    if (!utter.final) drawWave();
    if (utter.expiresAt !== null && now >= utter.expiresAt) {
      toast('Not sent');
      abortUtterance(false);
    }
  }
  requestAnimationFrame(loop);
}

// ---- HUD + toasts ------------------------------------------------------------------------------

function renderHud(): void {
  if (!enabled) return;
  if (!layout.connected) {
    hud(layout.error ? `herdr: ${escapeHtml(layout.error)}` : 'looking for herdr…', 'error', true);
    return;
  }
  const blocked = layout.panes.filter((p) => p.state === 'blocked');
  const v = view;
  if (v?.talking) {
    const id = utter?.paneId;
    hud(`🎙 talking to <b>${escapeHtml(id ? name(id) : '…')}</b>`, 'talk', true);
  } else if (v?.armed) {
    const target = v.hoverPaneId ?? v.addressedPaneId;
    const who = target ? `<b>${escapeHtml(name(target))}</b>` : '';
    const text =
      v.pose === 'point' && who ? `☝️ ${who}` :
      v.pose === 'pinch' ? `🤏 ${who || 'pinch'}` :
      v.pose === 'thumbUp' ? `👍 ${who}` :
      v.pose === 'thumbDown' ? `👎 ${who}` :
      v.pose === 'fist' ? `✊ ${who}` :
      who ? `✋ ${who}` : '✋ tracking';
    hud(text, 'armed', true);
  } else if (blocked.length > 0) {
    const names = blocked.map((p) => `<b>${escapeHtml(p.label)}</b>`).join(', ');
    hud(`${names} ${blocked.length > 1 ? 'need' : 'needs'} you`, 'blocked', true);
  } else {
    hud('', 'idle', false);
  }
}

let hudKey = '';
function hud(html: string, mode: string, on: boolean): void {
  const key = `${html}|${mode}|${on}`;
  if (key === hudKey) return;
  hudKey = key;
  const el = $('hud');
  el.dataset.mode = mode;
  el.classList.toggle('on', on);
  if (html) (el.querySelector('.hud-text') as HTMLElement).innerHTML = html;
}

function toast(text: string): void {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild!.remove();
  setTimeout(() => el.classList.add('out'), 2200);
  setTimeout(() => el.remove(), 2600);
}

function name(paneId: string): string {
  return layout.panes.find((p) => p.id === paneId)?.label ?? 'agent';
}

function nobodyBlocked(): string {
  const n = layout.panes.filter((p: PaneView) => p.state === 'blocked').length;
  return n > 1 ? 'Point at the agent you want to answer' : 'No agent is waiting for an answer';
}

function poseLabel(v: EngineView): string {
  if (v.talking) return 'talking';
  return { point: 'pointing', pinch: 'pinch', fist: 'fist', thumbUp: 'thumbs up', thumbDown: 'thumbs down', open: 'open hand', other: '', none: '', talk: 'talking' }[v.pose] ?? '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Expose a few hooks for automated tests (driven over the DevTools protocol).
(window as unknown as { __hands: unknown }).__hands = {
  get view() {
    return view;
  },
  get layout() {
    return layout;
  },
  get fps() {
    return fps;
  },
  get utterance() {
    return utter && { id: utter.id, route: utter.route };
  },
  get delegate() {
    return vision.delegate;
  },
  simulate: (e: EngineEvent) => handle(e),
  speech: (e: SpeechEvent) => onSpeech(e),
};

void boot();
