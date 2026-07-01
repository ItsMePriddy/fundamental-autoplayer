# Headless Fundamental harness

Runs the **real** Fundamental game logic in Node (no browser) so the autoplayer's
policies can be tuned against ground truth with timewarp — a 4-hour playthrough
simulates in well under a second.

## How it works
`build.sh` clones the game, guards only its browser "Start everything" boot block
behind a `__HEADLESS__` flag (keeping all state init + exports), and compiles the
TypeScript to CommonJS in `./build`. `_globals.js` stubs the browser globals
(`document`, `localStorage`, …) before the modules load. `engine.js` then exposes:
- `newGame()` + `buyBuildings`/`buyUpgrades`/`buyStrange` — the real
  `prepareVacuum`/`updatePlayer`/`buyBuilding`/etc. calls, exactly as the
  userscript drives them through the DOM.
- `vaporBoost()` / `mergeBoost()` — reimplementations of the exact expressions
  the game uses to fill `#vaporizationBoostTotal` / `#mergeBoostTotal`, built by
  calling the same `Stage.calculateEffects.*` functions rather than
  hand-deriving the formulas, so they can't drift from the game's own math.

## Run
```
./build.sh                        # one-time (clones + compiles game)
node sweep.js                     # run every built-in strategy against the
                                   # newest save in Resources/saves/, print a
                                   # comparison table (one child process per
                                   # strategy — in-process looping OOMs)
node sweep.js shipped             # run just one strategy (see its header for
                                   # the full list + flags: --save, --simHours,
                                   # --seconds, and ad-hoc --collapseMult=X /
                                   # --vapBoost=X overrides)
node grid-sweep.js --axis=collapseMult   # wide single-axis parameter sweep,
                                   # log-spaced values, ranked by quarks/sim-hour
```
See `sweep.js`'s header comment for the full usage and the built-in strategy
table. It loads a real save via `updatePlayer(json, true)` rather than starting
fresh (`newGame()`), since the questions worth validating are almost always
about mid-to-late-game behavior.
