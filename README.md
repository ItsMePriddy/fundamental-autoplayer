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

In Stage 4, the panel shows banked raw mass, projected raw collapse mass, and their
true ROI ratio against its trigger, plus the last observed collapse. Pending star
remnants accumulate toward a batch target (50 by default) before triggering a
star-only collapse — firing on every single remnant was measured to slow the whole
progression loop ~2.6× by keeping built-up production perpetually wiped.

## What it does

Driven entirely through the game's DOM (the game is an IIFE bundle that exposes no
globals):

- Buys all structures, upgrades/research, and strangeness every tick.
- Discharges / vaporizes / collapses (`reset0`) when ready; attempts stage and end
  resets on a slower cadence.
- Sets confirmation prompts to "None" so resets never block, and turns on the game's
  own automation + auto-stage-switching.
- Pre-configures the game's own auto-vaporize / auto-collapse threshold inputs, so
  once the matching "Automatic" strangeness upgrades are bought, the game's native
  automation runs with the script's tuned values instead of untouched defaults.
- Auto-accepts the offline-time dialog.

## Important: keep the tab in the foreground

Like most idle games, Fundamental advances production on `requestAnimationFrame`,
which browsers **freeze for hidden/background tabs**. The bot pauses its actions and
shows `paused - tab hidden` while the tab is hidden. For continuous play, leave the
game in its own focused window. Brief switches are fine — the game grants
offline-time catch-up on return (auto-accepted by the script).

## License

MIT
