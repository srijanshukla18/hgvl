# herdr hands

**Point at an agent and talk to it.**

A gesture + voice layer for [Herdr](https://github.com/ogulcancelik/herdr). Your webcam tracks one hand; your index finger becomes a laser over the Herdr window; a handful of gestures approve, deny, stop and zoom agents; pinch-and-hold to dictate a prompt to whichever agent you're pointing at. Speech runs locally on NVIDIA **Canary 180M Flash**, the same model you use in Handy. Nothing leaves your machine.

This is the **demo build**. It does the parts that make a great one-minute video, and does them well. The rest of the spec is in the [roadmap](#roadmap).

## Gestures

| Do this | While | It does |
| --- | --- | --- |
| ✋ raise a hand | any time | overlay wakes up, pane frames fade in |
| ☝️ point | — | laser pointer; the pane under it is *addressed* |
| 👍 thumbs up | an agent is waiting | approve (addressed agent, or the only waiting one) |
| 👎 thumbs down | an agent is waiting | deny · also cancels a dictation before it's sent |
| ✊ fist, hold ~0.7 s | pointing at an agent | interrupt it (Esc) |
| 🤏 pinch, tap | pointing at a pane | zoom it to full screen; tap again to unzoom |
| 🤏 pinch, **hold** and speak | pointing at an agent | live transcript → sent as a prompt on release |
| say "yes" / "no" / "stop" | pinch-talking to a waiting agent | same as 👍 / 👎 / ✊ |

Approvals whose prompt mentions something on the danger list (`deploy`, `rm -rf`, `git push --force`, `terraform apply`, …) need the 👍 **held** for about a second. A ring fills up and then it fires.

Agents that are blocked glow amber even when your hand is down, so you can see who needs you from across the room.

## Setup (macOS, Apple Silicon)

```bash
git clone <this repo> herdr-hands && cd herdr-hands
npm install          # also downloads the models (~210 MB): MediaPipe gestures + Canary 180M Flash
npm start            # builds and launches; look for ✋ in the menu bar
```

The first launch asks for **Camera** and **Microphone** access. Window tracking also needs **Accessibility**, granted to your terminal app under System Settings → Privacy & Security, because the overlay reads the terminal window's position through System Events.

Try it without Herdr first:

```bash
npm run mock         # four fake agents in a 2×2 grid; two of them start asking for approval
```

Menu bar ✋ → toggle hands on/off (also **⌘⇧H**), the camera preview and the gesture legend.

## Recording the demo

A one-minute script that shows off everything:

1. **0:00** Herdr full screen (native full screen works best), four agents running: e.g. two Claude Codes, Codex and opencode. Lean back.
2. **0:05** Claude stops to ask to run the tests. Its pane glows amber; the pill says *claude needs you*.
3. **0:08** Raise your hand, 👍. Green check, Claude carries on.
4. **0:14** Point at Codex. The laser glides over and the brackets snap onto its pane.
5. **0:18** Pinch and hold: *"add a p95 latency alert to the checkout dashboard"*. The words appear live under your hand. Let go; the prompt flies into Codex and it starts working.
6. **0:30** Point at opencode, pinch-tap: it zooms to full screen. Read. Pinch-tap: back to the grid.
7. **0:40** The infra agent asks to `wrangler deploy`. 👍 now shows *HOLD TO CONFIRM* and the ring fills. Or 👎 to deny.
8. **0:48** An agent is going off the rails: point, ✊ and hold. The ring fills and it stops.
9. **0:55** Drop your hand. The overlay fades away.

Tips: sit about an arm's length from the camera with your hand at chest height. The camera preview in the corner shows what's being tracked. Good front lighting matters more than anything else.

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
  "visionDelegate": "GPU"      // or "CPU"
}
```

If the laser and the highlighted pane don't line up with what you see, adjust `frameInsets` (for example `"top": 0` for a terminal without a title bar).

## How it works

```
 camera ──► MediaPipe gesture recognizer ──► gesture engine ──► intents ──► herdr socket
 (overlay renderer, 30 fps, GPU)               (pure TS, tested)             (main process)
                                                     │
 mic ──► 16 kHz capture (only while hand is up) ─────┴──► Canary 180M Flash (sherpa-onnx, utility process)
```

- **Electron overlay**: one transparent, click-through, always-on-top window over the display that shows Herdr. It never takes focus, so your keyboard is untouched.
- **Vision**: MediaPipe's gesture recognizer gives 21 hand landmarks plus canned gestures (👍 👎 ✊ ✋) in one model. The pointer is the index fingertip, smoothed with a one-euro filter and eased with a spring at display refresh rate. Pinch is detected from landmarks with hysteresis.
- **Engine** (`src/engine`): address-then-act. The pane you last pointed at, or the only waiting agent, gets the action. When your index curls into a 👍 or ✊ it drags the fingertip down, so the address rolls back to where the laser was 200 ms earlier. Gestures fire once per pose, with a cooldown, and dangerous approvals need a hold.
- **Voice**: the mic opens only while a hand is up, and keeps a one-second pre-roll so the first word isn't lost while the pinch is being recognised. Canary re-decodes the utterance a couple of times a second for the live transcript, then once more on release. The transcript is shown for 0.7 s before it's sent (1.5 s for long prompts); 👎 cancels.
- **Herdr**: see `src/main/herdr.ts`.

## Development

```bash
npm test             # gesture engine unit tests (node:test)
npm run typecheck
npm run mock         # overlay against fake agents
HANDS_DEVTOOLS=1 npm start
```

## Roadmap

Deliberately left out of the demo build (from the spec):

- **Keyboard wins**: drop to idle on any keystroke (needs a global key monitor).
- **Idle mode power budget**: 5 fps presence checks while no hand is up; unload the STT model after 10 min idle.
- **Grammar mode**: always-on keyword spotting ("yes", "no", "stop") while an agent is blocked, without a pinch.
- **Command mode**: pinch-talk with no pane addressed ("show dashboard workspace", "kill codex").
- **Pinch-drag**: scroll a pane with inertia; drag to swap panes.
- **Prompt card**: show the pending question and command next to the pill.
- **Corner calibration** with a homography, instead of fixed gain.
- Wispr Flow bridge mode, video-call auto-mute, thermal guard, local audit log, per-workspace config, Herdr plugin packaging (`herdr hands on|off`).
- Native Swift build (menu-bar app, Metal) once the interaction design is settled.
