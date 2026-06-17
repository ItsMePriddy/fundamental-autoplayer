# Fundamental Autoplayer

A [Tampermonkey](https://www.tampermonkey.net/) userscript that automatically plays
[awWhy's **Fundamental**](https://awwhy.github.io/Fundamental/) idle game.

## Install

1. Install the Tampermonkey browser extension.
2. Open the raw script link — Tampermonkey will offer to install it:
   **https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js**
3. Open / refresh https://awwhy.github.io/Fundamental/ — it auto-starts.

A **▶ Auto: ON/OFF** button appears bottom-right. You can also control it from the
console via `window.FundamentalBot.start()` / `.stop()`, and tune the `CONFIG` block
at the top of the script.

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
which browsers **freeze for hidden/background tabs**. The bot keeps clicking, but the
game clock only ticks while its tab is visible. For continuous play, leave the game
in its own focused window. Brief switches are fine — the game grants offline-time
catch-up on return (auto-accepted by the script).

## License

MIT
