# Status bar

A thin bar docked to the top of the screen on Windows (Electron + React). Windows treats it
like a second taskbar, so maximized windows stop below it. It hides itself while a game or
video is fullscreen.

- **Claude:** 5-hour and weekly plan usage, with a countdown and the clock time of each reset.
  Click to refresh.
- **Janas:** online/offline, model, memory use, and live activity: reading a prompt (progress
  and ETA) or writing a reply (tokens per second).
- **Hermes:** a small animated avatar that roams the middle of the bar and changes with what
  the Hermes agent is doing: asleep, idle, reading, thinking, using tools, done.
- **System:** CPU load and temperature, RAM, and NVIDIA GPU load, temperature and VRAM.

Right-click the bar (or click the tray dot) for the menu: sign in, refresh, preview Hermes
moods, hide, start with Windows, settings, quit.

## Requirements

- Windows 10 or 11
- Node.js 20 or newer
- An NVIDIA GPU with `nvidia-smi` on the PATH for GPU stats (optional)

## Run

```
npm install
npm start
```

npm may ask you to allow `koffi`'s install script (it calls the Windows appbar API):

```
npm install-scripts approve koffi
npm rebuild koffi
```

## Claude limits

Sign in once from the menu ("Sign in to claude.ai…"). The bar keeps its own claude.ai session
and asks for usage every 5 minutes. If Claude Code's command-line tool is signed in
(`~/.claude/.credentials.json`), that sign-in is used first. Both rely on endpoints Anthropic
doesn't document, so they may break.

## Janas live progress

Janas writes progress only when started with `--metrics FILE`. Add this to the end of the
`janas-server.exe` line in `%LOCALAPPDATA%\janas\start-janas-cpu.cmd`:

```
--metrics "%LOCALAPPDATA%\janas\metrics.jsonl"
```

The file holds counters and timings only, never the text of prompts or replies. Without it the
bar falls back to showing "Working" when janas-server is using CPU.

## Hermes avatar

The avatar follows `%LOCALAPPDATA%\hermes\logs\agent.log`. Only event names are matched
(message received, model call, tool call, turn ended); the text of your messages is never read
into the bar. If the log isn't there, the avatar says "Hermes not found" and naps.

Pick a character from the menu (Character) or click the avatar to cycle through them:
Classic, Hermes, Winged messenger, Blob, Ghost, Robot and Pixel sprite. The choice is saved.

## Settings

`%APPDATA%\statusbar\config.json`: `barHeight`, `janasUrl`, `metricsFile`, `claudePollMinutes`, `character`.
Restart the bar after editing.

## License

MIT
