# Fundamental Autoplayer

A [Tampermonkey](https://www.tampermonkey.net/) userscript that automatically plays
[awWhy's **Fundamental**](https://awwhy.github.io/Fundamental/) idle game.

## Install

1. Install the Tampermonkey browser extension.
2. Open the raw script link — Tampermonkey will offer to install it:
   **https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js**
3. Open / refresh https://awwhy.github.io/Fundamental/ — it auto-starts.

The **Fundamental Pilot** panel appears over the game. It explains the bot's current
decision, shows stage-specific reset progress, and provides working Pause/Resume,
Export save, Copy log, and Install latest actions. You can also control it from the
console via `window.FundamentalBot.start()` / `.stop()`, and tune the `CONFIG` block
at the top of the script.

In Stage 4, the panel separates banked mass from projected collapse mass, shows the
current ROI against its trigger, and reports the next mass threshold plus the last
observed collapse. This avoids presenting projected mass as a misleading "goal."

## What it does

Driven entirely through the game's DOM (the game is an IIFE bundle that exposes no
globals):

- Buys all structures, upgrades/research, and strangeness every tick.
- Discharges / vaporizes / collapses (`reset0`) when ready; attempts stage and end
  resets on a slower cadence.
- Sets confirmation prompts to "None" so resets never block, and turns on the game's
  own automation + auto-stage-switching.
- Auto-accepts the offline-time dialog.

## Important: keep the tab in the foreground

Like most idle games, Fundamental advances production on `requestAnimationFrame`,
which browsers **freeze for hidden/background tabs**. The bot pauses its actions and
shows `paused - tab hidden` while the tab is hidden. For continuous play, leave the
game in its own focused window. Brief switches are fine — the game grants
offline-time catch-up on return (auto-accepted by the script).

## License

MIT
