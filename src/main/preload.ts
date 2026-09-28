import { contextBridge, ipcRenderer } from 'electron';
import type { HandsBridge, Intent, LayoutSnapshot, SpeechEvent } from '../shared/types.ts';

const bridge: HandsBridge = {
  config: () => ipcRenderer.invoke('config'),
  onLayout: (cb) => void ipcRenderer.on('layout', (_e, l: LayoutSnapshot) => cb(l)),
  onSpeech: (cb) => void ipcRenderer.on('speech', (_e, s: SpeechEvent) => cb(s)),
  onToggle: (cb) => void ipcRenderer.on('toggle', (_e, on: boolean) => cb(on)),
  onDemo: (cb) => void ipcRenderer.on('demo', (_e, cmd: string) => cb(cmd)),
  intent: (intent: Intent) => ipcRenderer.invoke('intent', intent),
  speechStart: (id) => ipcRenderer.send('speech:start', id),
  speechChunk: (id, samples) => ipcRenderer.send('speech:chunk', id, samples),
  speechEnd: (id, cancel) => ipcRenderer.send('speech:end', id, cancel),
  log: (...args) => ipcRenderer.send('log', args.map(String).join(' ')),
};

contextBridge.exposeInMainWorld('hands', bridge);
