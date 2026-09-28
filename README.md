# hgvl

**Herdr Gesture + Voice Layer.** Point at an agent and talk to it.

A gesture + voice layer for [Herdr](https://github.com/ogulcancelik/herdr). Your webcam tracks one hand; your index finger becomes a laser over the Herdr window; a handful of gestures approve, deny and stop agents; pinch-and-hold to dictate a prompt to whichever agent you're pointing at, then 👍 to send it. Speech runs locally on NVIDIA **Canary 180M Flash** (the model Handy uses). Nothing leaves your machine. As a safety net, the app refuses all outbound network requests at runtime. One side effect: MediaPipe's built-in usage stats (performance counters, never camera frames) aren't sent. The one exception is [Jev](#jev-optional), which is off unless you give it an OpenRouter key.

This is an early build: the core loop (point, gesture, talk, confirm) works well; the rest of the spec is in the [roadmap](#roadmap).

## Gestures

| Do this | While | It does |
| --- | --- | --- |
| ✋ raise a hand | any time | overlay wakes up, pane frames fade in |
| ☝️ point | — | laser pointer; the pane under it is *addressed* |
| 👍 thumbs up | an agent is waiting | approve (addressed agent, or the only waiting one) |
| 👎 thumbs down | an agent is waiting | deny |
| ✊ fist, hold ~0.7 s | pointing at an agent | interrupt it (Esc) |
| 🤏 pinch, **hold** and speak | pointing at an agent (anywhere, with Jev) | live transcript; on release the card says what 👍 will do |
| 👍 / 👎 | a transcript is waiting | send it / throw it away (dropped after 20 s either way) |
| say "yes" / "no" / "stop", then 👍 | pinch-talking to a waiting agent | same as 👍 / 👎 / ✊ |
| say "go to the api tab", "switch to infra", "tell codex to…", then 👍 | pinch-talking, with Jev | switch tab or workspace, or prompt the agent you named |

Risky approvals need the 👍 **held** for about a second: a ring fills up and then it fires. An approval is risky when the agent's pending prompt matches the danger list (`deploy`, `rm -rf`, `git push --force`, `terraform apply`, …) or, with Jev, when Jev judges it hard to undo.

A short pinch does nothing; only a held pinch starts dictation. Transcripts made only of stray letters or punctuation ("T S F", ".") are dropped as noise.

Agents that are blocked glow amber even when your hand is down, so you can see who needs you from across the room.

## Setup (macOS, Apple Silicon)

```bash
git clone <this repo> hgvl && cd hgvl
npm install          # also downloads the models (~210 MB): MediaPipe gestures + Canary 180M Flash
npm start            # builds and launches; look for ✋ in the menu bar
```

The first launch asks for **Camera** and **Microphone** access, and for permission to control **System Events**, which is how it finds the terminal window that shows Herdr. If the laser and pane highlights don't line up, check System Settings → Privacy & Security → Accessibility / Automation for the app you launched `npm start` from.

Herdr must already be running (`herdr` in any terminal). If you use a named session, start with `HERDR_SESSION=<name> npm start`.

**Full screen is the easiest setup.** Put the terminal running Herdr in native full screen. The overlay follows it onto that Space and there's no title bar to account for.

Try it without Herdr first:

```bash
npm run mock         # four fake agents in a 2×2 grid; two of them start asking for approval
```

Menu bar ✋ → toggle hands on/off (also **⌘⇧H**), the camera preview and the gesture legend. The menu also shows whether Jev is on.

Optional: add an OpenRouter key to turn on [Jev](#jev-optional) (voice commands, talking without pointing, danger checks). `.env` is git-ignored.

## Tips

- Sit about an arm's length from the camera with your hand at chest height. The camera preview in the corner shows what's being tracked. Good front lighting matters more than anything else.
- If the laser feels too twitchy or too slow, change `pointerGain`. If your hand sits high or low in the frame, change `pointerCenter`.
- When a name is both a tab and a workspace, say which one: "go to the website **tab**". The card always shows what 👍 will do, so 👎 if it guessed wrong.
- Keep your hand down (or ⌘⇧H) while typing, so nothing gets addressed by accident.
- Practise with `npm run mock` first. The fake agents block on a timer, so you can rehearse the whole flow without spending tokens.

## Jev (optional)

[Jev](https://openrouter.ai/docs/guides/community/jev) is TypeSafe's decision model: it answers typed questions with probabilities, in about 0.3–0.8 s and for a fraction of a cent. With a key, hgvl uses it for three things:

- **Voice commands.** Each transcript gets one Jev call that decides, in parallel, what you want (prompt, approve, deny, stop, switch tab, switch workspace), which agent you mean and which tab or workspace you named. The options are built from Herdr's live state. Without Jev, only exact "yes" / "no" / "stop" are recognised and everything else is a prompt.
- **Talking without pointing.** Say "tell codex to add tests" or "go to the api tab" with your hand anywhere; the card shows the target before you 👍.
- **Danger check.** When an agent blocks, its pending prompt is judged for being hard to undo (deploys, force-pushes, deletes, releases, outgoing messages). Risky approvals need the 👍 held, as do approvals made before the verdict arrives. The `dangerList` substrings still apply on top.

Turn it on by putting your key in `.env` at the repo root (or the environment):

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env
```

**What it sends**: the transcript, the names and states of agents, tabs and workspaces, and the last ~14 non-empty lines of a blocked agent's terminal. Requests ask providers not to retain data (`data_collection: deny`). If Jev is unreachable, everything falls back to the local rules. Set `"jev": { "enabled": false }` to keep the key but not use it.

## Configuration

Optional `~/.config/herdr/hands.json`. Every key is optional:

```jsonc
{
  "showCamera": true,          // camera preview in the corner
  "sounds": true,
  "pointerGain": 1.8,          // higher = less hand movement to cross the screen
  "pointerCenter": [0.5, 0.55], // where your hand sits in the camera frame when aiming at the centre
  "dangerList": ["deploy", "rm -rf", "git push --force", "terraform apply"],
  "terminalApp": "auto",       // or "Ghostty", "iTerm2", "Terminal", "WezTerm", …
  "frameInsets": { "top": "auto", "left": 0, "right": 0, "bottom": 0 },  // trim title bar / padding
  "herdrSocket": null,         // defaults to herdr's own socket discovery
  "agents": { "claude": { "approve": ["enter"], "deny": ["esc"], "interrupt": ["esc"] } },  // herdr logical keys
  "visionDelegate": "GPU",     // or "CPU"
  "jev": { "enabled": true, "model": "typesafe/jev-1.13", "timeoutMs": 3000 }  // used only with OPENROUTER_API_KEY
}
```

If the laser and the highlighted pane don't line up with what you see, adjust `frameInsets` (for example `"top": 0` for a terminal without a title bar).

## How it works

```
 camera ──► MediaPipe gesture recognizer ──► gesture engine ──► intents ──► herdr socket
 (overlay renderer, 30 fps, GPU)               (pure TS, tested)             (main process)
                                                     │                              ▲
 mic ──► 16 kHz capture (only while hand is up) ─────┴──► Canary 180M Flash ──► route ──┘
                                                         (sherpa-onnx, utility   (local rules, or Jev
                                                          process)                via OpenRouter, optional)
```

- **Electron overlay**: one transparent, click-through, always-on-top window over the display that shows Herdr. It never takes focus, so your keyboard is untouched. It has no network access: the page's CSP and the Electron session both refuse remote requests.
- **Vision**: MediaPipe's gesture recognizer gives 21 hand landmarks plus canned gestures (👍 👎 ✊ ✋) in one model. The pointer is the index fingertip, smoothed with a one-euro filter and eased with a spring at display refresh rate. Pinch is detected from landmarks with hysteresis.
- **Engine** (`src/engine`): address-then-act. The pane you last pointed at, or the only waiting agent, gets the action. When your index curls into a 👍 or ✊ it drags the fingertip down, so the address rolls back to where the laser was 200 ms earlier. Gestures fire once per pose, with a cooldown, and dangerous approvals need a hold.
- **Voice**: the mic opens only while a hand is up, and keeps a one-second pre-roll so the first word isn't lost while the pinch is being recognised. Canary re-decodes the utterance a couple of times a second for the live transcript, then once more on release. Transcripts made only of stray letters ("T S F") are dropped as noise. The final transcript waits on screen: 👍 sends it, 👎 throws it away, and after 20 s it's dropped.
- **Jev** (`src/main/route.ts`, `src/main/danger.ts`): calls come from the main process only; the overlay stays offline. Routing option keys (`p1`, `t3`, …) map back to Herdr ids, and a command whose probability is under 0.5 falls back to a prompt. Tabs and workspaces are switched with `tab.focus` / `workspace.focus`.
- **Herdr** (`src/main/herdr.ts`, tested against herdr 0.9.1): a plain client of the session socket (`~/.config/herdr/herdr.sock`, or `HERDR_SESSION` / `HERDR_SOCKET_PATH`). State comes from `session.snapshot`, refreshed on every `events.subscribe` event (layout, focus, per-pane agent status) plus a 1 s poll. Approve, deny and stop are `agent.send_keys` (Enter / Esc for Claude Code, `y` / Esc for Codex); dictation is `agent.prompt`. Blocked panes are read with `pane.read` so the danger list (and Jev) can see the pending command. No changes to Herdr or the agent CLIs.
- **Geometry** (`src/main/geometry.ts`): `pane.layout` rects are in cells relative to the tab area. `pane.graphics.info` gives the attached client's cell size in pixels. Together with the terminal window's frame (System Events), that places every pane to the pixel, after Herdr's sidebar and tab bar.

## Development

```bash
npm test             # unit tests (node:test): gesture engine, geometry, voice routing, transcript filter
npm run typecheck
npm run mock         # overlay against fake agents
HANDS_DEVTOOLS=1 npm start
```

## Roadmap

Not built yet (from the spec):

- **Keyboard wins**: drop to idle on any keystroke (needs a global key monitor).
- **Idle mode power budget**: 5 fps presence checks while no hand is up; unload the STT model after 10 min idle.
- **Grammar mode**: always-on keyword spotting ("yes", "no", "stop") while an agent is blocked, without a pinch.
- **Command mode without Jev**: voice navigation with a local decision model (e.g. a small on-device classifier) so it works offline.
- **Pinch-drag**: scroll a pane with inertia; drag to swap panes.
- **Prompt card**: show the pending question and command next to the pill.
- **Corner calibration** with a homography, instead of fixed gain.
- Wispr Flow bridge mode, video-call auto-mute, thermal guard, local audit log, per-workspace config, Herdr plugin packaging (`herdr hands on|off`).
- Native Swift build (menu-bar app, Metal) once the interaction design is settled.
