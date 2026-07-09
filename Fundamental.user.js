// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.18.6
// @description  Automatically plays awWhy's "Fundamental" idle game by driving its DOM controls: buys all structures/upgrades/strangeness, performs resets when ready, enables the game's own automation + auto-stage switching, and pushes every stage's milestones toward their final unlocks when feasible.
// @author       ItsMePriddy
// @match        https://awwhy.github.io/Fundamental/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js
// @downloadURL  https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js
// ==/UserScript==

/*
 * HOW IT WORKS
 * ------------
 * The game (Fundamental v0.2.9) is shipped as a single non-module IIFE bundle
 * (Code.js), so none of its internals (player state, buyBuilding, timeUpdate...)
 * are reachable from the page's global scope. Everything here is therefore done
 * by clicking the game's real DOM buttons, whose IDs are stable across the UI.
 *
 * The game clock freezes in hidden/background tabs, so the bot marks the HUD as
 * paused and skips game actions until the tab is visible again.
 *
 * Strategy:
 *   1. One-time-ish setup (re-checked cheaply every tick, only acts when needed):
 *        - set every confirmation toggle (toggleConfirm0..7) to "None" so resets
 *          never pop a blocking dialog,
 *        - turn ON the game's own automation (toggleAll, toggleAuto0..11,
 *          toggleVerse0) and auto-stage-switch (toggleNormal0). These do nothing
 *          until the matching "strangeness" upgrades are bought, at which point the
 *          game auto-runs that part for us optimally.
 *   2. Every tick (resets BEFORE purchases — see the comment in tick(); buying
 *      first let stage 2 vaporize on a stale, inflated boost reading):
 *        - discharge / vaporize / .. -> #reset0Button (when ready)
 *        - buy all structures        -> #makeAllFooter
 *        - buy all upgrades/research -> #createAllFooter
 *        - buy all strangeness       -> #createAllStrangeness
 *   3. On a slower cadence: attempt stage reset (#reset1Button) and end reset
 *      (#reset2Button) when their button text says they're ready.
 *   4. Auto-accept the "offline time" dialog that pops up whenever the tab
 *      regains focus, so it never blocks unattended play.
 *   5. Milestone completion engine (non-vacuum): reads the game's own autosave
 *      from localStorage to know each stage milestone's tier, per-tier time
 *      limit, and progress counter, then holds stage resets, disables native
 *      auto-stage reset, and temporarily suppresses discharge/vaporize (whose
 *      resets WIPE those counters) while a tier is still winnable this run —
 *      with per-tier retry backoff once an attempt fails, so hopeless tiers
 *      don't drag the quark loop. See the
 *      "Milestone completion engine" section for mechanics + sim evidence.
 *
 * Readiness is read from button text because these reset buttons are never marked
 * .disabled — when not ready they read "Next goal is ...", "Requires ...", etc.
 *
 * IMPORTANT — keep the tab in the FOREGROUND:
 *   Like most idle games, Fundamental advances production on requestAnimationFrame,
 *   which the browser FREEZES while the tab is hidden/backgrounded. The bot now
 *   pauses its actions and shows "paused - tab hidden" in the HUD until visible.
 *   For continuous play, leave the game in its own focused window/tab. Brief
 *   switches are fine — on return the game grants "offline time" (auto-accepted here).
 */

(function () {
    'use strict';

    // Extract the bot version from the @version userscript header at runtime
    // so bumping the header tag automatically updates the HUD, console log,
    // and cache-busted install URL. With @grant none, Tampermonkey injects this
    // userscript as a <script> element whose textContent is the full source.
    const BOT_VERSION = (function extractVersion() {
        try {
            var cs = document.currentScript;
            if (cs && cs.textContent) {
                var m = cs.textContent.match(/@version\s+([\d.]+)/);
                if (m) return m[1];
            }
        } catch (e) { /* fall through to hardcoded fallback */ }
        // Fallback — keep in sync with @version; used only when extraction fails.
        return '1.18.6';
    })();
    const UPDATE_URL = 'https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js';

    // ---- Config ---------------------------------------------------------------
    const CONFIG = {
        tickMs: 250,            // main loop interval
        slowResetEveryMs: 8000, // how often to attempt stage/end resets
        autoStart: true,        // start playing on load
        enableGameAutomation: true, // flip the game's own auto toggles ON
        setConfirmNone: true,   // set confirmation prompts to "None"
        doStageReset: true,     // attempt #reset1Button (stage reset) when ready
        doEndReset: true,       // attempt #reset2Button (end reset) when ready
        vaporizeMode: 'fixed',  // stage 2 timing. 'fixed' is recommended: a headless full-game
                                // simulation of Submerged shows fixed boost ~2.25 is optimal and
                                // the curve is flat across 2-3 (time-to-target varies <6%).
                                // 'adaptive' is NOT recommended for Submerged — validated to
                                // underperform badly there (the cloud divisor + effect softcap
                                // make ln(boost)/elapsed peak at a worthless ~1.05, causing
                                // hundreds of tiny resets). Kept only for experimentation.
        vaporizeBoost: 2.25,    // 'fixed' mode: vaporize when the production boost reaches this
                                // multiple. ~2.25 was the empirical optimum for Submerged; the
                                // game's default of 2 is essentially as good. Higher (5+) is
                                // slower (too few resets).
        vaporizeMinGapMs: 3000, // fixed mode: minimum time since last vaporization before
                                // firing again. Prevents rapid-fire loops where the bot
                                // rebuilds engines in 1-2 ticks and immediately crosses the
                                // boost threshold again before clouds have meaningfully accumulated.
        vaporizeMinBoost: 1.5,  // adaptive only: never fire below this boost.
        vaporizePeakDrop: 0.05, // adaptive only: fire once ln(boost)/elapsed drops this fraction
                                // below its running max.
        logCycles: true,        // record each vaporization cycle for tuning/validation.
                                // Inspect via window.FundamentalBot.report().
        logCollapses: true,     // record every observed Stage 4 collapse for diagnosis.
                                // Inspect via window.FundamentalBot.collapseReport().
        highStageResets: false, // stage 6 (nucleation) is a major prestige reset. Leave false to
                                // let the GAME's auto-resets handle it. (Stages 4/5 — collapse and
                                // merge — have their own dedicated boost-gated logic below.)
        mergeBoost: 2,          // stage 5 (Intergalactic): merge when #mergeBoostTotal reaches this
                                // multiple. The boost is the multiplicative gain of merging now
                                // ((galaxies/(merged+1)+1)·rewardRatio). The game HARD-CAPS merges
                                // (mergeMaxResets ≈ 2 early) and requires ≥22 galaxies — both
                                // enforced on reset0Button (resetReady() gates them) — so a boost
                                // gate can't over-merge; it just times the few merges available.
                                // Self-disables once strangeness[5][9]≥2: the game then auto-merges
                                // and hides #mergeBoostTotal, so the bot defers to it.
        mergeMaxWaitMs: 120000, // anti-hang: also merge after this long once actionable, in case
                                // the boost reads modest but galaxies are capped on available mass.
        mergeMinBoost: 1.2,     // floor for the anti-hang merge — don't fire a worthless one.
        holdStage5WhenActionable: true, // don't stage-reset out of Intergalactic while Galaxy/Merge
                                // work is visible. Early Stage 5 can be mostly locked; in that case
                                // resetting to farm quarks is still correct. Once Galaxies/Merges
                                // are real, holding preserves compounding Stage 5 progress.
        stage5HoldGraceMs: 60000, // when merge boost is below the anti-hang floor (1.2×), hold
                                // this long for initial building buy-up after entering the stage,
                                // then release to farm quarks. Quark gain cannot grow meaningfully
                                // without merges (the only significant growth source is
                                // mergeInfo.galaxies+1, which only increments on merge).
        collapseBoost: 2.0,     // stage 4: collapse when the production boost
                                // (#collapseBoostTotal) reaches this multiple — headless
                                // simulations from a real Interstellar save show the optimum is
                                // 1.8-2.0. The star-gain trigger below handles most collapses;
                                // this boost gate catches the high-value ones the star trigger
                                // might miss during rapid growth.
        collapseMaxWaitMs: 120000, // anti-hang timer: 2 minutes. Headless data shows the anti-hang
                                // should be a safety net, not the primary driver — a short (45s)
                                // timer dominates all sweeps and produces a worse 0.055 stars/s;
                                // at 120s with a 1.1× floor, it only catches what the primary
                                // 1.3× ROI trigger missed.
        collapseMinBoost: 1.0,  // floor for the anti-hang collapse — kept low so the anti-hang can
                                // fire even when boost is flatlined (no buildings purchasable ->
                                // boost stays 1.0). The game's own collapseResetCheck still
                                // prevents worthless collapses (it rejects when starCheck=0
                                // AND newMass≤currentMass AND no pending elements).
        collapseHardStallMs: 300000, // hard-stall breaker: fire an unconditional collapse after
                                // 5 minutes without ANY collapse, regardless of boost. This breaks
                                // deadlocks where boost is 1.0 and the anti-hang keeps getting
                                // rejected by the game (mass hasn't increased, no stars available).
                                // Even a rejected click keeps the timer running so the breaker
                                // eventually forces a state change through sheer elapsed time.
        collapseOnElement: true, // collapse ASAP when a new element is pending (awaiting activation)
                                // — elements only activate on collapse and their boost isn't in
                                // #collapseBoostTotal, so grabbing them fast is high-ROI.
        collapseElementGapMs: 3000, // min gap between element-triggered collapses (avoids a double
                                // fire during the render lag before the element flips to "created").
        collapseMinGapMs: 2000,  // min gap between collapse attempts (prevents rapid-fire while
                                // conditions stay satisfied across consecutive ticks).
        collapseStarBatch: 50,  // the stars trigger fires only once the SUM of pending star
                                // remnants reaches this count. Firing on ANY pending remnant
                                // (the pre-v1.14 behavior: batch 1, 2s gap) measured ~2.6x fewer
                                // quarks/hour AND ~12x slower star banking over 100 matched
                                // sim-hours: +1-star collapses wipe production before buildings
                                // compound, so banked mass crawls at ~1.001x per collapse,
                                // mass-gated elements stall, and the whole loop drags. >=50 with
                                // a 30s gap measured identical to disabling the trigger entirely;
                                // kept as a safety valve for solar-hardcap regimes where the mass
                                // ratio can't reach collapseMassMultiplier but big star batches
                                // still accumulate.
        collapseStarGapMs: 30000, // min gap between star-batch collapses.
        collapseMassMultiplier: 1.3,
                                // #footerStat2Span is player.collapse.mass: the real banked raw
                                // mass. Collapse at projected/banked >= 1.3×, the headless optimum.
        collapseAntihangMassMin: 1.3,
                                // Anti-hang uses the same raw-mass ratio floor as primary ROI,
                                // so elapsed time can never undercut the intended mass gain.
        autoExport: true,       // stage 5+: periodically click #export to claim Strange-quark
                                // rewards. The save-file download it triggers is suppressed
                                // (no files saved) — only the in-game reward is kept.
        exportEveryMs: 10000,   // 10s. The reward scales with elapsed time (conversion =
                                // min(time/12h, 1)), so total quarks/hour is the SAME at any
                                // cadence below 12h — exporting often just claims them in small
                                // continuous amounts that get reinvested into strangeness right
                                // away instead of sitting idle. (12h only maxes a SINGLE export.)
        smartStrangeness: true, // route the shared strange-quark pool to the CURRENT stage first,
                                // then highest->lowest, instead of the game's stage-1-first dump.
        strangenessTargets: [
                                // Priority route (first UNOWNED entry gets a dedicated saving
                                // window — see strangenessTargetTimeoutMs). DOM ids are the
                                // strangeness array index + 1 (strange3Stage5 = strangeness[5][2]).
            'strange3Stage5',   // s5 idx2: 1.4×/lvl quark multiplier — compounds ALL future
                                //   quark income; always pursued first (also clicked
                                //   unconditionally every tick as double insurance).
            'strange4Stage5',   // s5 idx3: Intergalactic collapse-immunity + enables
                                //   auto-upgrades there — gating unlock for Stage 5 progress.
            'strange5Stage4',   // s4 idx4: Automatic Collapse — hands stage 4 timing to the
                                //   game's native auto, which then runs on the #collapseInput
                                //   threshold this script pre-configures (see
                                //   configureNativeAutomation).
            'strange5Stage2',   // s2 idx4: Automatic Vaporization — same handoff for stage 2
                                //   via #vaporizationInput.
            'strange7Stage5',   // s5 idx6: Automatic Stage reset (~480 quarks) — the key
                                //   unlock for running the full quark loop hands-free.
            'strange5Stage5',   // s5 idx4: Automatic Galaxy (~15,600 quarks) — auto-collapse
                                //   for Galaxy affordability once Intergalactic is real.
            'strange10Stage5',  // s5 idx9: Automatic Merge (~6e6 quarks) — endgame; its
                                //   saving window will simply expire until income catches up.
        ],
        strangenessTarget: null, // legacy single-target override; use strangenessTargets above.
        strangenessTargetTimeoutMs: 600000, // dedicated saving window per target: while the first
                                // unowned target is within this window, ALL other strangeness
                                // spending holds so quarks accumulate for it. When the window
                                // expires (or the target is bought), normal buying resumes — the
                                // target keeps being clicked first every tick, so it's still
                                // grabbed the moment it becomes affordable. (Pre-v1.15 this
                                // window only expired for LOCKED-looking targets; an unlocked but
                                // unaffordable one held all spending indefinitely, which froze
                                // strangeness buying entirely once late-game targets got
                                // expensive.)
        configureNativeAutomation: true, // once "Automatic Vaporization"/"Automatic Collapse"
                                // strangeness is owned, the GAME's own timeUpdate() already calls
                                // its internal vaporizationResetCheck()/collapseResetCheck() every
                                // tick — completely independent of this script — using whatever is
                                // in the #vaporizationInput/#collapseInput settings fields as its
                                // threshold. Those default to 3x/2x and are never touched unless a
                                // player edits them by hand, so left alone the native auto-system
                                // silently runs on an untuned number. Set them from CONFIG once per
                                // session (harmless pre-unlock: the game only reads them inside the
                                // natively-gated auto path) so whichever system fires — native or
                                // this script's own polling below, which keeps running unchanged
                                // alongside it — uses the same threshold. UNITS MATTER: #vaporizationInput is the
                                // same boost ratio as #vaporizationBoostTotal (-> vaporizeBoost),
                                // but #collapseInput is compared against the PRODUCTION-BOOST
                                // formula (#collapseBoostTotal), NOT the raw projected/banked mass
                                // ratio — so it maps to collapseBoost, never collapseMassMultiplier.
                                // (Source-verified against the compiled game; see
                                // headless/build/Stage.js vaporizationResetCheck/collapseResetCheck
                                // and Main.js's #vaporizationInput/#collapseInput 'change' handlers.)
        milestoneAttempts: true, // non-vacuum: actively complete every stage's MILESTONES for
                                // their final-tier unlocks (Permanent stages, the Intergalactic
                                // structures + Galaxy researches, stage-5 strangeness). Each
                                // pending tier must be reached within a per-tier time limit
                                // measured against the CURRENT run's stage time, and its
                                // progress counter is WIPED by that stage's small reset —
                                // discharge zeroes the "produced this reset" quark total (and
                                // spends the energy the s1 milestone scores until
                                // strangeness[1][4]>=2), vaporize zeroes the drop total and the
                                // simultaneous-puddle count. So while a tier's window is open
                                // the bot holds the stage reset, disables the game's native Stage
                                // reset auto, and after a ramp phase (below) suppresses that
                                // stage's small reset — its own clicks plus the game's native
                                // auto via toggleAuto1/toggleAuto2. Replaces
                                // v1.16's stage-4/5-only milestoneRunHold: windows subsume it
                                // (hold exactly while a milestone is still winnable, release the
                                // moment none is). Sim-validated from a real save over 36 simH
                                // (headless/milestone-probe.js, 'ship' variant): +19 tiers —
                                // maxing 'Supermassive' (Intergalactic unlock), 'Light in the
                                // dark', 'Satellites of Satellites', 'Fundamental Matter' and
                                // 'A Nebula of Drops' — vs ZERO tiers ever earned without
                                // attempts, while quarks/simH more than DOUBLED vs baseline
                                // (the unlocks compound; 156 loops completed vs 20 for blind
                                // attempts without backoff).
        milestoneRampFrac: 0.3, // fraction of the tightest open window during which discharge/
                                // vaporize still run normally before suppression starts.
                                // Production must ramp through discharges/vaporizes first:
                                // full-window suppression reached 1e-159% of the s1 quark
                                // target in sim; a 0.3 ramp then a suppressed accumulation
                                // stretch earned the tier outright. Collapse is deliberately
                                // NOT suppressed for the stage-5 star milestone: normal
                                // collapse cadence reached 97%+ of the star target while
                                // suppressing collapses starved production to ~3%.
        milestoneRetryNearMs: 1800000,  // failed-window retry cooldown when the attempt got
                                // >=90% of the target (30 min — it'll land soon as power grows).
        milestoneRetryFarMs: 3600000,   // cooldown for 30-90% attempts (1 h).
        milestoneRetryHopelessMs: 10800000, // cooldown below 30% (3 h). All three double per
                                // consecutive failure (capped below). Backoff is what makes
                                // attempts affordable: sim WITHOUT it re-attempted every run,
                                // cut quark income ~70%, and the near-miss tiers STILL never
                                // landed (income too low to grow into them); with it the loop
                                // recovers between probes and grows through the targets.
        milestoneRetryCapMs: 21600000, // 6 h cap on any single retry cooldown.
        milestoneQuarkFarm: true, // late Stage 5 galaxy milestones scale hard with unspent
                                // Strange-quark stageBoost. If End of Greatness is the only
                                // live target and quarks are below the reserve table below,
                                // release stage reset to farm quarks first, then resume
                                // milestone mode once the reserve is met.
        milestoneGalaxyReserveQuarks: [0, 10000, 10000, 10000, 10000, 10000, 25000, 50000],
                                // Reserve by current s5[1] tier before attempting the next
                                // End of Greatness tier. Matched probes from the 2026-07-09
                                // Intergalactic save: +10k quarks turns 1/8 -> 6/8 in 3h;
                                // +25k/+50k materially improves the last two near-misses.
        milestoneQuarkFarmResetWaitMs: 1200000,
                                // Farm Stage 4/5 for 20 minutes before taking a Stage-reset
                                // quark reward. Probe against the 09.07.2026 Interstellar save:
                                // 50k unspent landed in 2.33h at 20m, while 5m took 4.75h.
                                // Long loops build galaxies, which multiply the reward.
        runStallReleaseMs: 720000, // declare an open milestone window dead for THIS run after
                                // this long without a >2% improvement in its tracked counter
                                // (12 min) — its retry cooldown starts immediately, and once
                                // every open window is dead the stage reset is released.
        runHoldMaxMs: 10800000, // hard safety cap on a single run hold (3 h) regardless of
                                // window math — the longest real window is ~2.4 h and shrinks
                                // as tiers rise, so this only guards against a future game
                                // update changing the tables underneath us.
        verbose: false,         // log every action to console
    };

    // Text on a reset button that means "not ready yet".
    const NOT_READY = /requires|next (?:goal|rank)|reach|need|self[- ]?made|locked|unlock|to unlock/i;

    // ---- Helpers --------------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    const exists = (id) => $(id) != null;

    const clickIf = (id) => {
        const el = $(id);
        if (el && !el.disabled) { el.click(); return true; }
        return false;
    };

    const textOf = (id) => {
        const el = $(id);
        return el ? (el.textContent || '').trim() : '';
    };

    // Extract the first number from arbitrary text (handles "2.00", "1.50e3",
    // thousands separators, and surrounding words like "Reset for 1.2e4 Clouds").
    const numFromText = (t) => {
        if (!t) return null;
        const m = t.replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
        return m ? parseFloat(m[0]) : null;
    };
    // Parse a number out of a stat element's text. Returns null if absent.
    const readNum = (selector) => {
        const el = document.querySelector(selector);
        return el ? numFromText(el.textContent) : null;
    };

    // Active stage, read from the on-screen stage name (no globals are exposed).
    // Index matches the game's word list in Player.ts.
    const STAGE_WORDS = ['', 'microworld', 'submerged', 'accretion', 'interstellar', 'intergalactic', 'abyss'];
    const activeStage = () => {
        const w = textOf('stageWord').toLowerCase();
        const i = STAGE_WORDS.findIndex((s) => s && w.startsWith(s));
        return i > 0 ? i : 0;
    };

    // A reset/action button is "ready" if it exists, isn't disabled, and its label
    // doesn't read like a requirement message.
    const resetReady = (id) => {
        const el = $(id);
        if (!el || el.disabled) return false;
        const t = (el.textContent || '').trim();
        if (!t) return false;
        return !NOT_READY.test(t);
    };

    // Two-state ON/OFF toggles (text contains "ON" or "OFF"): click to reach ON.
    const setToggleOn = (id) => {
        const el = $(id);
        if (!el) return;
        const t = (el.textContent || '').toUpperCase();
        // Already on if it ends with ON but not OFF.
        if (/\bON\b/.test(t) && !/\bOFF\b/.test(t)) return;
        el.click();
    };

    const setToggleOff = (id) => {
        const el = $(id);
        if (!el) return;
        const t = (el.textContent || '').toUpperCase();
        if (/\bOFF\b/.test(t)) return; // already off
        el.click();
    };

    // Confirmation toggles cycle Safe -> None -> All. Click until it reads "None".
    const setConfirmNone = (id) => {
        const el = $(id);
        if (!el) return;
        for (let i = 0; i < 3; i++) {
            if ((el.textContent || '').trim() === 'None') return;
            el.click();
        }
    };

    const log = (...a) => { if (CONFIG.verbose) console.log('[Fundamental]', ...a); };

    // Rolling event log for the on-screen HUD.
    const eventLog = [];
    const pushLog = (msg) => {
        eventLog.push({ t: Date.now(), msg });
        if (eventLog.length > 60) eventLog.shift();
    };
    const STAGE_NAMES = ['', 'Microworld', 'Submerged', 'Accretion', 'Interstellar', 'Intergalactic', 'Abyss'];
    const fmtDur = (s) => {
        s = Math.max(0, Math.floor(s));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`
                 : `${m}:${String(x).padStart(2, '0')}`;
    };

    // ---- Offline-time dialog --------------------------------------------------
    // On (re)focus the game shows an alert: "Accept and use N seconds worth of
    // Offline time?". It blocks everything until answered. Auto-accept it, but
    // only when it's really the offline prompt (don't blindly confirm other alerts).
    function acceptOfflineDialog() {
        const box = $('alertMain');
        if (!box || getComputedStyle(box).display === 'none') return; // no dialog showing
        const msg = textOf('alertText');
        if (/offline time/i.test(msg)) clickIf('alertConfirm');
    }

    // ---- Setup pass (cheap, idempotent) --------------------------------------
    // BUG FIX: throttle applySettings to every ~2s instead of every tick.
    // The toggles don't change state between ticks (the game's own autos
    // persist), so re-asserting 4×/second was pure DOM churn — ~15 queries
    // per tick = 60/sec of needless layout work. BUT: when the milestone
    // engine toggles suppression (suppressDischarge/suppressVaporize), the
    // game's auto must be turned off IMMEDIATELY or it fires within the next
    // game tick and wipes the milestone counter. So suppression transitions
    // bypass the throttle.
    let lastApplySettings = 0;
    let prevHoldStageReset = false;
    let prevFarmStageReset = false;
    let prevSuppressDischarge = false;
    let prevSuppressVaporize = false;
    const APPLY_SETTINGS_MS = 2000;
    function applySettings() {
        const now = Date.now();
        const suppressChanged = (msCtl.holdStageReset !== prevHoldStageReset) ||
                                (msCtl.farmStageReset !== prevFarmStageReset) ||
                                (msCtl.suppressDischarge !== prevSuppressDischarge) ||
                                (msCtl.suppressVaporize !== prevSuppressVaporize);
        if (!suppressChanged && now - lastApplySettings < APPLY_SETTINGS_MS) return;
        lastApplySettings = now;
        prevHoldStageReset = msCtl.holdStageReset;
        prevFarmStageReset = msCtl.farmStageReset;
        prevSuppressDischarge = msCtl.suppressDischarge;
        prevSuppressVaporize = msCtl.suppressVaporize;
        if (CONFIG.setConfirmNone) {
            for (let i = 0; i <= 7; i++) setConfirmNone('toggleConfirm' + i);
        }
        if (CONFIG.enableGameAutomation) {
            setToggleOn('toggleAll');                 // master building automation
            setToggleOn('toggleVerse0');              // universe automation
            for (let i = 0; i <= 11; i++) {
                // The milestone engine temporarily owns Stage reset (0),
                // discharge (1), and vaporization (2). Stage reset ends the
                // whole timed window; discharge/vaporize wipe stage-specific
                // counters. When milestone mode is active, the game's own autos
                // must be OFF too, not just this script's clicks.
                if (i === 0 && (msCtl.holdStageReset || msCtl.farmStageReset)) { setToggleOff('toggleAuto0'); continue; }
                if (i === 1 && msCtl.suppressDischarge) { setToggleOff('toggleAuto1'); continue; }
                if (i === 2 && msCtl.suppressVaporize) { setToggleOff('toggleAuto2'); continue; }
                setToggleOn('toggleAuto' + i); // discharge/stage/upgrade autos
            }
            setToggleOn('toggleNormal0');             // auto-switch active stage
        }
    }

    // ---- Native automation handoff ---------------------------------------------
    // No unlock detection: #vaporizationInput / #collapseInput exist in the static
    // page HTML from boot, their 'change' listeners are registered in the game's
    // boot block, and the values they write (vaporization.input[0] /
    // collapse.input[0]) are ONLY read inside the game's natively-gated auto path
    // (vaporizationResetCheck/collapseResetCheck, gated on the Automatic
    // strangeness or researchesAuto unlocks). Writing them before the unlock is
    // therefore a harmless no-op that becomes exactly right the moment the unlock
    // lands. (v1.13.0 tried to detect the unlock via #toggleVaporizationHotkey /
    // #toggleCollapseHotkey visibility — but those live inside the Hotkeys window,
    // which openHotkeys() builds LAZILY on first open. The bot never opens it, so
    // detection never fired and the feature was a silent no-op. Verified against
    // the live deployed bundle, not just the compiled clone.)
    // Configured once per session, then re-asserted every ~60s. Stage resets
    // and game reloads can wipe these inputs, and the old once-per-session flag
    // meant the bot silently stopped auto-vaporizing/auto-collapsing after a
    // reset. Re-asserting checks the current value and only writes if needed
    // (setNativeInput already no-ops when already at target).
    const nativeConfigured = { vaporize: false, collapse: false };
    let lastNativeReassert = 0;
    const NATIVE_REASSERT_MS = 60000; // re-check every 60s
    function setNativeInput(id, target) {
        const el = $(id);
        if (!el) return false;
        const current = numFromText(el.value);
        if (current !== null && Math.abs(current - target) < 1e-9) return true; // already set
        el.value = String(target);
        el.dispatchEvent(new Event('change'));
        return true;
    }
    function configureNativeAutomation() {
        if (!CONFIG.configureNativeAutomation) return;
        // BUG FIX: re-assert every ~60s instead of once per session. Stage
        // resets can wipe these native auto inputs. The once-per-session flags
        // meant a reset silently disabled auto-vaporize/auto-collapse until the
        // page was reloaded. Now we periodically clear the flags so the inputs
        // are re-checked (and re-set if missing/wrong).
        const now = Date.now();
        if (nativeConfigured.vaporize && nativeConfigured.collapse && now - lastNativeReassert < NATIVE_REASSERT_MS) return;
        if (now - lastNativeReassert >= NATIVE_REASSERT_MS) {
            nativeConfigured.vaporize = false;
            nativeConfigured.collapse = false;
            lastNativeReassert = now;
        }
        if (!nativeConfigured.vaporize) {
            nativeConfigured.vaporize = setNativeInput('vaporizationInput', CONFIG.vaporizeBoost);
            if (nativeConfigured.vaporize) pushLog(`⚙️ native auto-vaporize threshold set to ${CONFIG.vaporizeBoost}×`);
        }
        if (!nativeConfigured.collapse) {
            // collapseBoost, NOT collapseMassMultiplier: the game compares this input
            // against the production-boost ratio (#collapseBoostTotal), and 1.3 in
            // boost units would collapse far too eagerly.
            nativeConfigured.collapse = setNativeInput('collapseInput', CONFIG.collapseBoost);
            if (nativeConfigured.collapse) pushLog(`⚙️ native auto-collapse threshold set to ${CONFIG.collapseBoost}× boost`);
        }
    }

    // ---- Buying pass ----------------------------------------------------------
    function buyEverything() {
        clickIf('makeAllFooter');       // all structures (active stage)
        clickIf('createAllFooter');     // all upgrades + researches
        if (CONFIG.smartStrangeness) buyStrangenessSmart();
        else clickIf('createAllStrangeness');
    }

    // Strange quarks are a SHARED pool, but the game's "create all strangeness" buys stages
    // 1->6 ASCENDING — draining quarks into low-stage upgrades you're long past before the
    // stage you're actually progressing. Route them by priority instead: current stage first,
    // then highest->lowest (lower stages still get the leftovers). Each click buys max of that
    // upgrade; missing/maxed/locked/unaffordable buttons are harmless no-ops.
    // Per-upgrade ROI: the ONE globally-compounding strangeness is the quark-gain multiplier
    // (stage 5 index 2 -> strange3Stage5: "Gain 1.4x more Strange quarks from any Stage reset"),
    // which multiplies ALL future quark income — buy it before anything else. strange4Stage5
    // (Intergalactic collapse-immunity + enables Upgrade automatization there) is the next key
    // unlock. Everything else is local/automation and is well-served by current-stage-first below.
    // strangenessTargets: upgrades to buy NEXT, in priority order. The first unowned target
    // gets ONE dedicated saving window (strangenessTargetTimeoutMs): all other strangeness
    // spending holds so the shared quark pool accumulates for it. When the window expires or
    // the target is bought, normal buying resumes — every unowned target is still clicked
    // first each tick, so it's grabbed the instant it's affordable. Each target's window is
    // tracked separately (pre-v1.15, one shared timer meant later targets got shortened or
    // zero windows, and unlocked-but-expensive targets held spending FOREVER — which froze
    // strangeness buying entirely once the cheap early targets were owned).
    let strangeTargetId = null;
    let strangeTargetStart = 0;
    function strangeUnowned(id) {
        const m = textOf(id).match(/(\d[\d.eE+]*)\s*\/\s*(\d[\d.eE+]*)/);
        return m ? parseFloat(m[1]) < parseFloat(m[2]) : false; // unparseable/maxed -> treat as owned
    }
    function currentStrangenessTarget() {
        const targets = Array.isArray(CONFIG.strangenessTargets) && CONFIG.strangenessTargets.length
            ? CONFIG.strangenessTargets
            : (CONFIG.strangenessTarget ? [CONFIG.strangenessTarget] : []);
        return targets.find((id) => $(id) && strangeUnowned(id)) || null;
    }
    let lastBuyStrangeness = 0;
    const BUY_STRANGENESS_MS = 2000;

    // ---- Smart strangeness save-vs-spend strategy ----------------------------
    // Unspent strange quarks provide a stageBoost: production *= quarks^exp.
    // Spending quarks on upgrades reduces the boost. The smart strategy decides
    // when to hoard (preserve boost) vs spend (buy upgrades) by comparing the
    // marginal production loss from spending against the upgrade's benefit.
    //
    // Exponents (non-vacuum, from Stage.js source):
    //   S1=0.22  S2=0.18  S3=0.76  S4=0.16  S5=0.06
    // Gating (strangeness[s][idx] >= level required for boost to activate):
    //   S1: [1][6]>=1  S2: [2][6]>=1  S3: [3][7]>=1  S4: [4][7]>=1  S5: [5][7]>=1
    // Formula: stageBoost[s] = (unspentQuarks + 1) ^ exp[s]  (the +1 is from
    //   the game's strangeInfo.stageBoost calculation using current+1)
    const STAGE_BOOST_EXP = { 1: 0.22, 2: 0.18, 3: 0.76, 4: 0.16, 5: 0.06 };
    const STAGE_BOOST_GATE = { 1: [6, 1], 2: [6, 1], 3: [7, 1], 4: [7, 1], 5: [7, 1] };

    function stageBoostActive(sv, stage) {
        if (!sv || !sv.strangeness || !sv.strangeness[stage]) return false;
        const [idx, lvl] = STAGE_BOOST_GATE[stage] || [0, 999];
        return (sv.strangeness[stage][idx] || 0) >= lvl;
    }

    // Marginal production multiplier lost by spending `cost` quarks when
    // currently holding `quarks` unspent, for a stage with exponent `exp`.
    // boost = (q+1)^exp. After spending: (q-cost+1)^exp.
    // Fractional loss = 1 - (q-cost+1)^exp / (q+1)^exp
    function boostLossFraction(quarks, cost, exp) {
        if (quarks <= 0 || cost <= 0 || exp <= 0) return 0;
        const before = Math.pow(quarks + 1, exp);
        const after = Math.pow(Math.max(0, quarks - cost) + 1, exp);
        return before > 0 ? 1 - (after / before) : 0;
    }

    // Read unspent quarks from save. Returns 0 if unreadable.
    function unspentQuarks() {
        const sv = readGameSave();
        if (!sv || !sv.strange || !sv.strange[0]) return 0;
        return sv.strange[0].current || 0;
    }

    function buyStrangenessSmart() {
        // BUG FIX: throttle to every ~2s. Strangeness upgrades are bought with
        // strange quarks, which only arrive on stage resets — checking 70+
        // buttons every 250ms was pure DOM churn. The high-ROI target
        // (strange3Stage5) is still clicked every tick via the saving window
        // fast path below.
        const now = Date.now();
        if (now - lastBuyStrangeness < BUY_STRANGENESS_MS) {
            // Fast path: still try the top-priority target every tick so it's
            // grabbed the instant quarks arrive from a reset.
            clickIf('strange3Stage5');
            const target = currentStrangenessTarget();
            if (target) clickIf(target);
            return;
        }
        lastBuyStrangeness = now;
        clickIf('strange3Stage5'); // highest-ROI quark-gain multiplier — always pursue (compounds income)

        const target = currentStrangenessTarget();
        if (target !== strangeTargetId) {
            // Target changed (previous one bought, or list edited) — start a fresh window.
            strangeTargetId = target;
            strangeTargetStart = target ? Date.now() : 0;
            if (target) pushLog(`💠 saving for ${target} (${Math.round(CONFIG.strangenessTargetTimeoutMs / 60000)} min window)`);
        }
        if (target) {
            clickIf(target); // buy it the instant quarks allow
            if (Date.now() - strangeTargetStart <= CONFIG.strangenessTargetTimeoutMs) return; // hold the rest
            // Window expired: fall through to normal buying. The target stays first in
            // line (clicked above each tick) until it's actually bought.
        }
        clickIf('strange4Stage5'); // Intergalactic collapse-immunity / enables auto-upgrade there

        // Smart save-vs-spend: if the current stage has an active stageBoost
        // with a high exponent (especially S3's 0.76), spending quarks gut the
        // production multiplier. We hold a reserve when the marginal loss is
        // significant. When stageBoost is inactive (gating not met), spend
        // freely — hoarding yields nothing.
        const cur = activeStage();
        const sv = readGameSave();
        const boostOn = stageBoostActive(sv, cur);
        const exp = STAGE_BOOST_EXP[cur] || 0;
        const quarks = unspentQuarks();

        if (boostOn && exp >= 0.15 && quarks > 0) {
            // stageBoost is active and exponent is meaningful. Compute how much
            // production we'd lose by spending down to a threshold. We reserve
            // enough quarks so that spending 1 more would lose < 1% of the boost.
            // marginal loss per quark ≈ exp * (q+1)^(exp-1) / (q+1)^exp = exp/(q+1)
            // We want exp/(q+1) < 0.01  →  q > exp/0.01 - 1  →  q > 100*exp - 1
            // For S3 (exp=0.76): reserve floor ≈ 75 quarks. Below that, hoard.
            const reserveFloor = Math.ceil(100 * exp) - 1;
            if (quarks <= reserveFloor) {
                // Hoarding: don't spend on low-priority upgrades. Only the
                // priority targets above (strange3Stage5, target, strange4Stage5)
                // get clicked — everything else is held to preserve the boost.
                if (quarks < reserveFloor * 0.5) {
                    pushLog(`⏸ hoarding ${quarks.toFixed(1)} quarks (reserve floor ${reserveFloor} for S${cur} boost ^${exp})`);
                }
                return;
            }
            // Above the reserve floor: spend freely but log the boost loss.
            const lossFrac = boostLossFraction(quarks, 1, exp);
            if (lossFrac > 0.005) {
                // Spending still costs > 0.5% of the boost per quark — proceed
                // but note it. At this quark level the loss is acceptable.
            }
        }

        const order = [cur];
        for (let s = 6; s >= 1; s--) if (s !== cur) order.push(s);
        // i <= 11: stage 5 has an 11th strangeness (strange11Stage5, Galactic tide);
        // clickIf is a no-op for stages that only have 10.
        for (const s of order) for (let i = 1; i <= 11; i++) clickIf('strange' + i + 'Stage' + s);
    }

    // ---- Vaporization timing (stage 2) ---------------------------------------
    // Vaporizing wipes the whole stage-2 engine, so each reset has a real rebuild
    // cost. Fastest stage completion = maximize the growth rate of the production
    // multiplier, i.e. maximize ln(boost)/T_cycle (a renewal-reward problem). The
    // optimum is the stopping rule: fire when ln(boost)/elapsed peaks. This self-
    // tunes to the actual ramp and the 1e4 cloud softcap with no magic constant.
    let vapLastTs = 0;       // timestamp of last vaporization (ms)
    let vapPeakScore = 0;    // running max of ln(boost)/elapsed this cycle
    const cycleLog = [];     // per-cycle records (capped)
    let vapCycleN = 0;

    const resetVaporTracking = () => { vapLastTs = Date.now(); vapPeakScore = 0; };

    // Record + perform a vaporization. `boost` is the production multiplier the
    // reset would grant right now (from #vaporizationBoostTotal).
    const doVaporize = (boost) => {
        const elapsed = vapLastTs ? (Date.now() - vapLastTs) / 1000 : 0;
        const cloudsBefore = readNum('#footerStat3Span');
        const projectedGain = numFromText(textOf('reset0Button')); // "Reset for X Clouds" — last render
        const clicked = clickIf('reset0Button');
        // The game's click handler runs numbersUpdate() synchronously, so this
        // post-click read is fresh. projected vs actual is the tell for the
        // stale-read race this ordering fix addresses — a healthy fire has
        // actual ≈ projected; a large shortfall means firing on stale numbers.
        const cloudsAfter = readNum('#footerStat3Span');
        const actualGain = clicked && cloudsBefore != null && cloudsAfter != null
            ? cloudsAfter - cloudsBefore
            : null;
        if (CONFIG.logCycles && elapsed > 0 && boost && boost > 1) {
            const rho = Math.log(boost) / elapsed; // realized growth rate (1/s) — the objective
            const rec = {
                n: ++vapCycleN,
                elapsed: +elapsed.toFixed(2),
                boost: +boost.toFixed(3),
                rho: +rho.toFixed(5),                       // ln(boost)/elapsed = what we maximize
                peakRho: +vapPeakScore.toFixed(5),          // best ρ seen this cycle (adaptive only)
                eff: vapPeakScore > 0 ? +(rho / vapPeakScore).toFixed(3) : null, // ρ_fire / ρ_peak
                clouds: cloudsBefore,                       // banked clouds before this reset
                cloudsGain: projectedGain,                  // projected (from button text)
                cloudsActual: actualGain == null ? null : Number(actualGain.toPrecision(4)),
            };
            cycleLog.push(rec);
            if (cycleLog.length > 500) cycleLog.shift();
            console.log(`[Fundamental] vap #${rec.n}: ${rec.boost}x in ${rec.elapsed}s | ρ=${rec.rho}/s peak=${rec.peakRho} eff=${rec.eff} | +${rec.cloudsGain} projected / ${rec.cloudsActual == null ? '?' : '+' + rec.cloudsActual} actual clouds`);
        }
        pushLog(`💨 vaporize ${boost ? boost.toFixed(2) : '?'}× · ${elapsed.toFixed(1)}s${actualGain != null ? ` · +${Number(actualGain.toPrecision(3))} clouds` : ''}`);
        resetVaporTracking();
    };

    function vaporizeStep() {
        if (!vapLastTs) vapLastTs = Date.now();
        const boost = readNum('#vaporizationBoostTotal > span');
        if (boost === null) return;

        if (CONFIG.vaporizeMode === 'fixed') {
            const elapsed = (Date.now() - vapLastTs) / 1000;
            if (elapsed >= CONFIG.vaporizeMinGapMs / 1000 && boost >= CONFIG.vaporizeBoost) doVaporize(boost);
            return;
        }

        // Adaptive: maximize ln(boost)/elapsed (renewal-reward optimum).
        const elapsed = (Date.now() - vapLastTs) / 1000;
        if (boost < CONFIG.vaporizeMinBoost || elapsed < 0.5) return; // too early / worthless

        const score = Math.log(boost) / elapsed;
        if (score > vapPeakScore) {
            vapPeakScore = score; // still climbing — keep accumulating
        } else if (score <= vapPeakScore * (1 - CONFIG.vaporizePeakDrop)) {
            doVaporize(boost); // peak passed — cashing out now maximizes growth rate
        }
    }

    // Summarize logged cycles. The adaptive rule is optimal when meanRho is at its
    // max: if raising vaporizePeakDrop (firing later, higher boost) increases
    // meanRho, we were firing too early, and vice-versa. meanBoost is the multiplier
    // the rule naturally settles on.
    const report = () => {
        if (!cycleLog.length) { console.log('[Fundamental] no vaporization cycles logged yet'); return null; }
        const mean = (k) => cycleLog.reduce((s, r) => s + (r[k] || 0), 0) / cycleLog.length;
        const summary = {
            mode: CONFIG.vaporizeMode,
            cycles: cycleLog.length,
            meanElapsedSec: +mean('elapsed').toFixed(2),
            meanBoost: +mean('boost').toFixed(2),
            meanRho_perSec: +mean('rho').toFixed(5), // higher = faster; the number to maximize
            meanEff: +mean('eff').toFixed(3),
        };
        console.log('[Fundamental] vaporization summary:', summary);
        console.table(cycleLog.slice(-50));
        return { summary, cycles: cycleLog.slice() };
    };

    // ---- Collapse timing (stage 4) -------------------------------------------
    // Collapse banks stars and raw mass by resetting stage-4 buildings. The raw
    // projected mass is visible in the button ("Collapse is at X Mass"), but the
    // current raw banked mass is #footerStat2Span (player.collapse.mass).
    // #solarMassStat is a different value: the projected/current mass-effect ratio.
    //
    // Triggers (checked in priority order, first match wins):
    //   1. A full BATCH of stars is pending (>= collapseStarBatch; the game accepts
    //      star-only collapses without a mass increase, but firing on every single
    //      remnant measured ~2.6x slower overall — see collapseStarBatch)
    //   2. Element-pending after collapseElementGapMs
    //   3. Raw projected/banked mass ROI reaches collapseMassMultiplier
    //   4. Total collapse boost reaches collapseBoost
    //   5. Hard-stall breaker after collapseHardStallMs
    //   6. Anti-hang after collapseMaxWaitMs, still gated by the raw-mass ROI floor
    //
    // #collapseBoostTotal disappears once the game's own auto-collapse takes over
    // (strangeness[4][4] ≥ 3) — then we leave timing to the game entirely.
    let collapseLastTs = 0;
    let collapseLastAttemptTs = 0;
    let collapseObservedMass = null;
    let collapseLastProjectedMass = null;
    let collapseN = 0;
    const collapseLog = [];
    function readStarGains() {
        return {
            s0: readNum('#special1Get'),
            s1: readNum('#special2Get'),
            s2: readNum('#special3Get'),
        };
    }
    const fmtMass = (value) => value == null
        ? '?'
        : Number(value).toLocaleString('en-US', { maximumSignificantDigits: 8 });
    function recordCollapse(data) {
        if (!CONFIG.logCollapses) return;
        const rec = {
            n: ++collapseN,
            time: new Date().toISOString(),
            source: data.source,
            accepted: data.accepted,
            reason: data.reason,
            bankedMassBefore: data.bankedMassBefore,
            projectedMass: data.projectedMass,
            projectedRatio: data.projectedRatio,
            bankedMassAfter: data.bankedMassAfter,
            totalBoost: data.totalBoost,
            elapsedSec: data.elapsedSec == null ? null : +data.elapsedSec.toFixed(2),
            starGain0: data.starGains?.[0] ?? null,
            starGain1: data.starGains?.[1] ?? null,
            starGain2: data.starGains?.[2] ?? null,
            pendingElements: data.pendingElements ?? null,
        };
        collapseLog.push(rec);
        if (collapseLog.length > 500) collapseLog.shift();
        const ratioText = rec.projectedRatio == null ? '?' : rec.projectedRatio.toFixed(4) + '×';
        const status = rec.accepted ? 'accepted' : 'rejected';
        console.log(
            `[Fundamental] collapse #${rec.n} ${status} (${rec.source}/${rec.reason}): ` +
            `banked ${fmtMass(rec.bankedMassBefore)} M☉ → projected ${fmtMass(rec.projectedMass)} M☉ ` +
            `(${ratioText}) → banked ${fmtMass(rec.bankedMassAfter)} M☉`,
            rec
        );
    }
    const collapseReport = () => {
        if (!collapseLog.length) {
            console.log('[Fundamental] no Stage 4 collapses logged yet');
            return null;
        }
        const accepted = collapseLog.filter((r) => r.accepted);
        const ratios = accepted.map((r) => r.projectedRatio).filter((v) => Number.isFinite(v));
        const summary = {
            records: collapseLog.length,
            accepted: accepted.length,
            rejected: collapseLog.length - accepted.length,
            scriptRecords: collapseLog.filter((r) => r.source === 'script').length,
            gameAutoRecords: collapseLog.filter((r) => r.source === 'game-auto').length,
            minProjectedRatio: ratios.length ? Math.min(...ratios) : null,
            meanProjectedRatio: ratios.length ? ratios.reduce((sum, v) => sum + v, 0) / ratios.length : null,
            maxProjectedRatio: ratios.length ? Math.max(...ratios) : null,
        };
        console.log('[Fundamental] collapse summary:', summary);
        console.table(collapseLog);
        return { summary, collapses: collapseLog.slice() };
    };
    function collapseStep() {
        if (!collapseLastTs) collapseLastTs = Date.now();
        // BUG FIX: split the early return so observation recording is explicit.
        // Previously `if (totalBoost == null || massRatio == null) return;` made
        // it ambiguous whether we were skipping because game-auto owns collapse
        // or because the mass ratio was unreadable. Now each case is separate
        // and the observation path (game-auto) is clearly delineated.
        if (!/collapse/i.test(textOf('reset0Button'))) return; // not the collapse reset / not actionable
        const bankedMassBefore = readNum('#footerStat2Span');
        const totalBoost = readNum('#collapseBoostTotal > span'); // null when the game auto-handles it
        if (collapseObservedMass == null) {
            collapseObservedMass = bankedMassBefore;
        } else if (totalBoost == null && bankedMassBefore != null && bankedMassBefore !== collapseObservedMass) {
            recordCollapse({
                source: 'game-auto',
                accepted: true,
                reason: 'observed mass change',
                bankedMassBefore: collapseObservedMass,
                projectedMass: collapseLastProjectedMass,
                projectedRatio: collapseLastProjectedMass != null && collapseObservedMass > 0
                    ? collapseLastProjectedMass / collapseObservedMass
                    : null,
                bankedMassAfter: bankedMassBefore,
                totalBoost: null,
                elapsedSec: null,
                starGains: null,
                pendingElements: document.querySelectorAll('[id^="element"].awaiting').length,
            });
            collapseObservedMass = bankedMassBefore;
        }
        // Keep the latest raw projected mass even when game automation owns collapse.
        const newMass = numFromText(textOf('reset0Button'));
        const massRatio = newMass != null && bankedMassBefore != null && bankedMassBefore > 0
            ? newMass / bankedMassBefore
            : null;
        collapseLastProjectedMass = newMass;
        // BUG FIX: split the ambiguous combined return into two explicit cases.
        // totalBoost == null means the game's own auto-collapse has taken over
        // (strangeness[4][4] ≥ 3) — we observe only, never fire. massRatio ==
        // null means we can't read the projected/banked mass yet — come back
        // next tick. Conflating these hid the observation-vs-action boundary.
        if (totalBoost == null) return; // game-auto owns collapse — observation only (handled above)
        if (massRatio == null) return;  // can't compute ROI yet — retry next tick
        const elapsed = (Date.now() - collapseLastTs) / 1000;
        const sinceAttempt = (Date.now() - collapseLastAttemptTs) / 1000;
        if (collapseLastAttemptTs && sinceAttempt < CONFIG.collapseMinGapMs / 1000) return;

        const sg = readStarGains();
        const pendingStars = (sg.s0 || 0) + (sg.s1 || 0) + (sg.s2 || 0);
        const hasStarGain = pendingStars > 0;
        const starReady = pendingStars >= CONFIG.collapseStarBatch;

        // Element pending (self-disabling when strangeness[4][6] ≥ 1)
        const elementPending = CONFIG.collapseOnElement && !!document.querySelector('[id^="element"].awaiting');

        let fire = false;
        let reason = '';

        if (starReady && elapsed >= CONFIG.collapseStarGapMs / 1000) {
            fire = true; reason = 'stars';                                   // 1. bank a full batch of ready stars
        } else if (elementPending && elapsed >= CONFIG.collapseElementGapMs / 1000) {
            fire = true; reason = 'element';                                 // 2. element pending
        } else if (massRatio >= CONFIG.collapseMassMultiplier &&
            elapsed >= CONFIG.collapseMinGapMs / 1000) {
            fire = true; reason = 'mass-roi';                                // 3. raw-mass ROI
        } else if (totalBoost >= CONFIG.collapseBoost) {
            fire = true; reason = 'boost';                                   // 4. strong total boost
        } else if (elapsed >= CONFIG.collapseHardStallMs / 1000) {
            fire = true; reason = 'hardstall';                               // 5. unconditional
        } else if (elapsed >= CONFIG.collapseMaxWaitMs / 1000 &&
                   totalBoost >= CONFIG.collapseMinBoost &&
                   massRatio >= CONFIG.collapseAntihangMassMin) {
            fire = true; reason = 'antihang';                                // 6. anti-hang (mass-gated)
        }

        if (fire) {
            const preStars = [sg.s0, sg.s1, sg.s2];
            const prePending = document.querySelectorAll('[id^="element"].awaiting').length;
            const clicked = clickIf('reset0Button');
            collapseLastAttemptTs = Date.now();

            // Confirm one of the three game-side rewards changed. The button contains
            // projected mass, so comparing its text alone can miss star-only collapses.
            const postBankedMass = readNum('#footerStat2Span');
            const postStars = readStarGains();
            const postPending = document.querySelectorAll('[id^="element"].awaiting').length;
            const starsChanged = [postStars.s0, postStars.s1, postStars.s2]
                .some((value, i) => value !== preStars[i]);
            const accepted = clicked && (
                (bankedMassBefore != null && postBankedMass != null && postBankedMass > bankedMassBefore) ||
                starsChanged ||
                postPending < prePending
            );
            if (accepted) {
                collapseLastTs = Date.now();
            }
            // If rejected, keep collapseLastTs so timers continue accumulating.
            recordCollapse({
                source: 'script',
                accepted,
                reason,
                bankedMassBefore,
                projectedMass: newMass,
                projectedRatio: massRatio,
                bankedMassAfter: postBankedMass,
                totalBoost,
                elapsedSec: elapsed,
                starGains: preStars,
                pendingElements: prePending,
            });
            if (postBankedMass != null) collapseObservedMass = postBankedMass;

            const gainDetail = hasStarGain ? ` +${[sg.s0,sg.s1,sg.s2].filter(v => v != null && v > 0).join('/')}★` : '';
            const massDetail = newMass ? ' ' + newMass.toFixed(2) + 'M☉' : '';
            pushLog('💥 collapse (' + reason + ')' + gainDetail + massDetail + ' ' + massRatio.toFixed(3) + '× mass');
        }
    }

    // ---- Merge timing (stage 5) ----------------------------------------------
    // Merge mirrors collapse's boost-gate but with two game-enforced guards that make it
    // safe to spam-gate: merging needs ≥22 galaxies AND is hard-capped (mergeMaxResets ≈ 2
    // early). Both are enforced on reset0Button — when unmet it reads "Requires…", so
    // resetReady() returns false and we don't fire. #mergeBoostTotal is the multiplicative
    // gain of merging now; it's hidden (→ null) once strangeness[5][9]≥2 hands merging to the
    // game's own auto-merge, at which point we stop and defer to the game (matching collapse).
    let mergeLastTs = 0;
    let stage5HoldStart = 0;
    function mergeStep() {
        if (!resetReady('reset0Button') || !/merge/i.test(textOf('reset0Button'))) {
            // BUG FIX: do NOT set mergeLastTs here. Previously this started the
            // anti-hang timer on the very first tick (when merge wasn't even
            // ready), so by the time merge became actionable the elapsed time
            // was already huge and the anti-hang fired immediately. The timer
            // must only start when merge is actually ready (below).
            return;
        }
        // Start the anti-hang timer only on the first ready tick. Preserved
        // across DOM flicker (not-ready for one tick doesn't zero it).
        if (!mergeLastTs) mergeLastTs = Date.now();
        const boost = readNum('#mergeBoostTotal > span');
        if (boost == null) return; // game auto-merges (strangeness[5][9]≥2) — leave timing to it
        const elapsed = (Date.now() - mergeLastTs) / 1000;
        const fire = boost >= CONFIG.mergeBoost ||
            (elapsed >= CONFIG.mergeMaxWaitMs / 1000 && boost >= CONFIG.mergeMinBoost);
        if (fire) {
            clickIf('reset0Button');
            mergeLastTs = Date.now();
            pushLog('🌀 merge ' + boost.toFixed(2) + '×');
        }
    }

    function stage5HasUnlockedWork() {
        const mergeBoost = readNum('#mergeBoostTotal > span');
        // Merge is actionable when ready, or when boost is high enough that
        // waiting for the 2.0× trigger is realistic. At 1.00× (all galaxies
        // merged, no rebuild underway) the bot can never reach the merge
        // threshold without a quark-farming loop — don't pretend there's work.
        if (/merge/i.test(textOf('reset0Button')) &&
            (resetReady('reset0Button') || (mergeBoost != null && mergeBoost >= CONFIG.mergeMinBoost))) return true;
        for (let i = 1; i <= 4; i++) {
            const name = textOf('building' + i + 'Name');
            const btn = textOf('building' + i + 'Btn');
            if (!name || !btn) continue;
            if (!/nebula|star|galax/i.test(name)) continue;
            if (!/locked|unlock/i.test(btn)) return true;
        }
        return false;
    }

    function shouldHoldStage5Reset() {
        if (!CONFIG.holdStage5WhenActionable || activeStage() !== 5) {
            stage5HoldStart = 0;
            return false;
        }
        if (!stage5HasUnlockedWork()) {
            stage5HoldStart = 0;
            return false;
        }
        if (!stage5HoldStart) stage5HoldStart = Date.now();
        const mergeBoost = readNum('#mergeBoostTotal > span');
        // Hold indefinitely if merge is actually ready or approaching
        if (/merge/i.test(textOf('reset0Button')) &&
            (resetReady('reset0Button') || (mergeBoost != null && mergeBoost >= CONFIG.mergeMinBoost))) return true;
        // Merge boost is below the anti-hang floor: quark gain can only grow
        // via element26, which is negligible.  Hold for a short grace period
        // for initial building buy-up, then release to farm quarks via stage
        // reset.
        return Date.now() - stage5HoldStart <= CONFIG.stage5HoldGraceMs;
    }

    // ---- Reset pass -----------------------------------------------------------
    // reset0 = discharge(1) / vaporization(2) / rank(3) / collapse(4) / merge(5) / nucleation(6).
    // Each stage's reset has a very different cost/benefit, so they are handled
    // individually rather than spammed uniformly.
    let prevStage = 0;
    function fastResets() {
        const s = activeStage();
        if (s === 0) {
            if (prevStage !== 0) pushLog('stage unknown - waiting');
            prevStage = 0;
            return;
        }
        if (s !== 2 && prevStage === 2) resetVaporTracking(); // left stage 2 — start fresh on return
        if (s !== 4 && prevStage === 4) {
            collapseLastTs = 0;
            collapseLastAttemptTs = 0;
            collapseObservedMass = null;
            collapseLastProjectedMass = null;
        } // left stage 4 — reset collapse cadence
        if (s !== 5 && prevStage === 5) { mergeLastTs = 0; stage5HoldStart = 0; } // left stage 5 — reset merge cadence + hold
        if (s !== prevStage && prevStage !== 0) pushLog(`🪐 stage → ${STAGE_NAMES[s] || s}`);
        prevStage = s;

        if (s === 1) {
            // Discharge: cheap and the regain is always beneficial — the standard
            // early strategy is to discharge constantly. (Don't gate on the label:
            // it can read "Next goal is X Energy" even when a discharge is available.)
            // EXCEPT while a stage-1 milestone attempt is accumulating: discharge
            // wipes the quark total and spends the energy those milestones score.
            if (!msCtl.suppressDischarge) clickIf('reset0Button');
        } else if (s === 2) {
            // Vaporize wipes the s2 milestone counters (drop total, puddle count) —
            // held during an attempt's accumulation phase.
            if (!msCtl.suppressVaporize) vaporizeStep();
        } else if (s === 3) {
            // Rank: hard-gated internally by a mass requirement and capped at maxRank,
            // so this advances milestones rather than looping. Safe to attempt.
            clickIf('reset0Button');
        } else if (s === 4) {
            collapseStep();
        } else if (s === 5) {
            mergeStep();
        } else if (CONFIG.highStageResets && resetReady('reset0Button')) {
            // Nucleation (stage 6): big prestige reset. Off by default — prefer the
            // game's own auto-resets, which time it optimally.
            clickIf('reset0Button');
            log('high-stage reset', s);
        }
    }

    // ---- Milestone completion engine (non-vacuum, all stages) ------------------
    // Non-vacuum milestones are the real progression gates: each stage has two,
    // each with 6-8 tiers, and the FINAL tier of each grants a permanent unlock
    // (Permanent Microworld/Submerged/Accretion, the Intergalactic structures,
    // Galaxy researches, stage-5 strangeness like 'Strange gain', the auto-stage-
    // to-Intergalactic toggle). Mechanics, source-verified against the compiled
    // game (headless/build/Stage.js assignMilestoneInformation/milestoneCheck,
    // Reset.js reset):
    //   - A tier is awarded automatically the moment its counter reaches the
    //     need value WHILE the run's stage time is still under a per-tier time
    //     limit. The limit SHRINKS as tiers rise (late tiers demand fast runs).
    //   - "This reset" counters are wiped by the stage's own SMALL reset:
    //     discharge calls reset('discharge',[1..5]) which zeroes building totals
    //     (s1 quark milestone) and spends current energy while strangeness[1][4]<2
    //     (s1 energy milestone); vaporization zeroes the s2 drop total and the
    //     simultaneous-puddle count; collapse zeroes the s5 self-made star count.
    //   - So the bot: (a) holds the stage reset while any pending tier's window
    //     is open, (b) lets discharge/vaporize run for the first milestoneRampFrac
    //     of the window (production MUST ramp first — sim: full suppression gets
    //     nowhere), then suppresses them so the counter can accumulate, (c) does
    //     NOT suppress collapse (sim: collapse cadence feeds the star milestone,
    //     suppressing it starves production), and (d) on a failed/stalled window
    //     starts a per-tier retry cooldown so the quark loop recovers.
    // All game state comes from the game's own autosave (localStorage
    // 'fundamentalSave', btoa(JSON), saved every 20 s) — the milestone DOM spans
    // only update while the Milestones subtab is open, so they can't be polled.
    // Validated end-to-end with headless/milestone-probe.js from a real save:
    // 'ship' variant earned +19 tiers in 36 simH (5 milestones maxed) with MORE
    // than double baseline quark income; every design choice above flips a probe
    // variant that measurably loses (see the probe's variant table).
    // Scaling tables + time-limit formula for game v0.2.9 (Player.ts
    // milestonesInfo[].scaling, Stage.ts assignMilestoneInformation non-vacuum
    // branch). If a game update changes these, re-verify against the compiled
    // build and re-run the probe.
    const GAME_VERSION = '0.2.9'; // the game version these tables are verified against
    let gameVersionWarningShown = false;
    function checkGameVersion() {
        if (gameVersionWarningShown) return;
        const sv = readGameSave();
        if (!sv) return; // save not loaded yet — try again next tick
        const saveVer = sv.version; // e.g. "v0.2.9"
        if (saveVer) {
            const normalized = String(saveVer).replace(/^v/i, '');
            if (normalized !== GAME_VERSION) {
                gameVersionWarningShown = true;
                const msg = `[Fundamental] WARNING: game save version is ${saveVer}, but milestone tables are calibrated for v${GAME_VERSION}. ` +
                    `If the game updated its milestone scaling, milestones may be attempted with wrong thresholds. ` +
                    `Re-verify against the compiled build and update MS_SCALING/MS_TIME_BASE if needed.`;
                console.warn(msg);
                pushLog(`⚠️ game v${normalized} — milestone tables may be stale (calibrated for v${GAME_VERSION})`);
            }
        }
    }
    const MS_SCALING = {
        1: [[1e152, 1e158, 1e164, 1e170, 1e178, 1e190], [23800, 24600, 25800, 27000, 28200, 29600]],
        2: [[1e30, 1e32, 1e34, 1e36, 1e38, 1e40, 1e44], [1500, 2300, 3100, 3900, 4700, 5500, 6400]],
        3: [[1e32, 1e34, 1e36, 1e38, 1e40, 1e42, 1e45], [24, 28, 32, 36, 40, 44, 50]],
        4: [[1e48, 1e49, 1e50, 1e52, 1e54, 1e56, 1e58, 1e60], [9000, 12000, 16000, 22000, 30000, 42000, 60000, 84000]],
        5: [[1460, 1540, 1620, 1700, 1780, 1860, 1940, 2020], [1, 2, 4, 6, 10, 14, 18, 22]],
    };
    const MS_TIME_BASE = { 1: 14400, 2: 28800, 3: 43200, 4: 57600 };
    const MS_TIME_K = { 1: [3, 11], 2: [7, 23], 3: [11, 35], 4: [15, 47] };
    const MS_NAMES = {
        1: ['Fundamental Matter', 'Energized'],
        2: ['A Nebula of Drops', 'Just a bigger Puddle'],
        3: ['Cluster of Mass', 'Satellites of Satellites'],
        4: ['Remnants of past', 'Supermassive'],
        5: ['Light in the dark', 'End of Greatness'],
    };
    // Per-tier time limit in seconds (stage time). Mirrors the game's formula.
    function msLimitSec(s, i, lvl, tree00) {
        const len = MS_SCALING[s][i].length;
        const pct = lvl / (len - 1);
        let t;
        if (s === 5) t = i === 0 ? 3600 / (pct * 2 + 1) : 1200;
        else t = MS_TIME_BASE[s] / Math.pow(pct * MS_TIME_K[s][i] + 1, pct);
        return tree00 ? t / 4 : t;
    }
    // The milestone's progress counter, read from the autosave. Mirrors
    // milestoneGetValue with two save-friendly proxies: s4[1] uses BANKED solar
    // mass (the projected value isn't saved; banking happens every collapse so
    // it tracks closely) and s5[0] sums self-made stage-4 structures (trueStars
    // isn't saved; both are incremented per buy and zeroed per collapse).
    function msValueFromSave(sv, s, i) {
        const B = sv.buildings || [];
        const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
        if (s === 1) return i === 0 ? N(B[1]?.[0]?.total) : N(sv.discharge?.energy);
        if (s === 2) return i === 0 ? N(B[2]?.[1]?.total) : N(B[2]?.[2]?.current);
        if (s === 3) return i === 0 ? N(B[3]?.[0]?.total) : (B[3]?.[4]?.true || 0) + (B[3]?.[5]?.true || 0);
        if (s === 4) {
            if (i === 0) return N(B[4]?.[0]?.total);
            // Supermassive tracks live solar mass (collapseInfo.newMass), NOT the
            // banked high-water mark (collapse.mass).  The game's milestoneGetValue
            // returns newMass — the live production value — while collapse.mass only
            // updates on collapse.  Reading collapse.mass makes the bot think the
            // counter is frozen (stalled) when it's actually growing, causing it to
            // hold the stage indefinitely for a target that's progressing fine.
            // Prefer the DOM's live value; fall back to save if unavailable.
            const domMass = readNum('#mainCapS5 > span')   // stage 5: live newMass
                         || readNum('#footerStat2Span')       // stage 4: banked (updates on collapse)
                         || null;
            if (domMass != null) return domMass;
            return N(sv.collapse?.mass);
        }
        if (s === 5) {
            if (i === 0) { let t = 0; for (let b = 1; b <= 5; b++) t += B[4]?.[b]?.true || 0; return t; }
            return B[5]?.[3]?.true || 0;
        }
        return null;
    }
    const fmtMsVal = (v) => v == null ? '?' : (Math.abs(v) >= 1e6 ? v.toExponential(2) : Math.round(v).toLocaleString('en-US'));

    // Autosave poll (cached; parsing 8 KB of base64 JSON every tick would be waste).
    let msSaveCache = null;
    let msSaveAt = 0;
    function readGameSave() {
        if (Date.now() - msSaveAt < 5000) return msSaveCache;
        msSaveAt = Date.now();
        try {
            const raw = localStorage.getItem('fundamentalSave');
            msSaveCache = raw ? JSON.parse(atob(raw)) : null;
        } catch (e) { msSaveCache = null; }
        return msSaveCache;
    }

    // Retry backoff, persisted across reloads. Key: s<stage>i<index>t<tier>.
    // Suffix bumps intentionally discard stale failed-window data from older
    // milestone policies; a bad backoff can hide every live milestone window.
    const MS_BACKOFF_KEY = 'fbMilestoneBackoff_v2';
    let msBackoff = {};
    try { msBackoff = JSON.parse(localStorage.getItem(MS_BACKOFF_KEY) || '{}') || {}; } catch (e) { msBackoff = {}; }
    const msSaveBackoff = () => { try { localStorage.setItem(MS_BACKOFF_KEY, JSON.stringify(msBackoff)); } catch (e) { /* quota — retry state is best-effort */ } };

    // Engine state. msCtl is read by applySettings/fastResets/slowResets each tick.
    let msCtl = { hold: false, holdStageReset: false, farmStageReset: false, suppressDischarge: false, suppressVaporize: false, hudLine: null };
    let msWindows = {};        // key -> { peak, lastImprove, need, lvl, s, i }
    let msRunDead = {};        // tiers given up on for the CURRENT run
    let msPrevEst = Infinity;  // last estimated stage time (new-run detection)
    let msPrevTiers = null;    // last seen player.milestones (award detection)
    let msLastTick = 0;        // detects hidden-tab gaps (stall clocks must not run then)
    let lastStageResetTs = 0;  // set when this script fires a stage/end reset
    let msFarmTarget = null;   // suppress repeated quark-farming transition logs

    // Estimated CURRENT stage time: the autosave's counter plus wall time since
    // it was written. If this script reset the stage more recently than the
    // save, the save describes the PREVIOUS run — count from our own click so a
    // fresh run isn't skipped during the (up to 20 s) autosave lag.
    function estStageTime(sv) {
        const saved = sv.time?.stage ?? 0;
        const savedAt = sv.time?.updated ?? Date.now();
        if (lastStageResetTs && savedAt < lastStageResetTs) return (Date.now() - lastStageResetTs) / 1000;
        return saved + Math.max(0, Date.now() - savedAt) / 1000;
    }

    function msCloseWindow(key, w, earned, why) {
        delete msWindows[key];
        if (earned) return; // award already logged; backoff entries cleared there
        const ratio = w.need > 0 && w.peak > 0 ? w.peak / w.need : 0;
        const fails = (msBackoff[key]?.fails || 0) + 1;
        const base = ratio >= 0.9 ? CONFIG.milestoneRetryNearMs
            : ratio >= 0.3 ? CONFIG.milestoneRetryFarMs
            : CONFIG.milestoneRetryHopelessMs;
        const cool = Math.min(base * Math.pow(2, fails - 1), CONFIG.milestoneRetryCapMs);
        msBackoff[key] = { fails, nextTryAt: Date.now() + cool };
        msSaveBackoff();
        pushLog(`⛰️ '${MS_NAMES[w.s][w.i]}' tier ${w.lvl + 1} ${why} at ${(ratio * 100).toFixed(0)}% — retry in ${fmtDur(cool / 1000)}`);
    }

    function msQuarkReserve(p) {
        if (!CONFIG.milestoneQuarkFarm) return 0;
        if (p.s !== 5 || p.i !== 1) return 0;
        const table = CONFIG.milestoneGalaxyReserveQuarks || [];
        return table[p.lvl] || 0;
    }

    function milestoneEngine() {
        const prev = msCtl;
        msCtl = { hold: false, holdStageReset: false, farmStageReset: false, suppressDischarge: false, suppressVaporize: false, hudLine: null };
        if (!CONFIG.milestoneAttempts) return;
        const sv = readGameSave();
        // Out of scope: no save yet, vacuum (different milestone system), inside a
        // challenge, pre-strangeness progression, or the inflation-tree upgrade
        // that removes time limits entirely (milestones then land in normal play).
        if (!sv || sv.inflation?.vacuum || sv.challenges?.active != null ||
            (sv.progress?.main ?? 0) < 11 || (sv.tree?.[0]?.[4] ?? 0) >= 1) return;

        // The game clock freezes while the tab is hidden, but the stall clocks
        // below are wall-time — shift them forward by any gap in engine ticks so
        // a backgrounded tab doesn't fail every open window on return.
        const nowTs = Date.now();
        if (msLastTick && nowTs - msLastTick > 5000) {
            const gap = nowTs - msLastTick;
            for (const key of Object.keys(msWindows)) msWindows[key].lastImprove += gap;
        }
        msLastTick = nowTs;

        // Award detection (tier rose between save polls).
        const tiers = sv.milestones || [];
        if (msPrevTiers) {
            for (let s = 1; s <= 5; s++) for (let i = 0; i < 2; i++) {
                const now = tiers[s]?.[i] ?? 0;
                if (now > (msPrevTiers[s]?.[i] ?? 0)) {
                    const max = MS_SCALING[s][i].length;
                    pushLog(`🏁 milestone '${MS_NAMES[s][i]}' tier ${now}/${max}${now >= max ? ' — MAXED, final unlock earned' : ''}`);
                    for (const key of Object.keys(msBackoff)) {
                        if (key.startsWith(`s${s}i${i}t`)) delete msBackoff[key]; // stale tiers
                    }
                    msSaveBackoff();
                }
            }
        }
        msPrevTiers = tiers;

        // New-run detection: a stage reset drops stage time from minutes to ~0.
        // The 30s threshold absorbs harmless small dips (a fresh autosave can
        // read a few seconds BEHIND the wall-clock estimate when the game's rAF
        // clock lagged) without missing any real reset.
        const est = estStageTime(sv);
        if (est < msPrevEst - 30) {
            for (const key of Object.keys(msWindows)) {
                const w = msWindows[key];
                msCloseWindow(key, w, (tiers[w.s]?.[w.i] ?? 0) > w.lvl, 'ended with the run');
            }
            msRunDead = {};
        }
        msPrevEst = est;

        // Pending tiers for the current run: the game scores min(current,4), plus
        // stage 5 alongside 4 (each s5 index gated on its s4 twin being maxed).
        const cur = Math.min(sv.stage?.current ?? 0, 4);
        if (cur < 1) return;
        const stages = cur === 4 ? [4, 5] : [cur];
        const tree00 = (sv.tree?.[0]?.[0] ?? 0) === 1;
        const open = [];
        for (const s of stages) {
            for (let i = 0; i < 2; i++) {
                const lvl = tiers[s]?.[i] ?? 0;
                if (lvl >= MS_SCALING[s][i].length) continue;              // maxed
                if (s === 5 && (tiers[4]?.[i] ?? 0) < 8) continue;         // s5 gate
                const key = `s${s}i${i}t${lvl}`;
                if (msRunDead[key]) continue;                              // gave up this run
                const bk = msBackoff[key];
                if (bk && Date.now() < bk.nextTryAt) continue;             // cooling down
                const limit = msLimitSec(s, i, lvl, tree00);
                if (est > limit) continue;                                 // window already shut
                open.push({ s, i, lvl, key, limit, need: MS_SCALING[s][i][lvl] });
            }
        }

        const quarks = sv.strange?.[0]?.current || 0;
        const farmed = [];
        const attemptable = [];
        for (const p of open) {
            const reserve = msQuarkReserve(p);
            if (reserve > 0 && quarks < reserve) farmed.push({ ...p, reserve });
            else attemptable.push(p);
        }
        open.length = 0;
        open.push(...attemptable);
        if (farmed.length && !open.length) {
            const p = farmed.reduce((a, b) => (a.reserve < b.reserve ? a : b));
            const key = p.key;
            msCtl.farmStageReset = true;
            const farmWait = CONFIG.milestoneQuarkFarmResetWaitMs / 1000;
            const runTime = estStageTime(sv);
            msCtl.hudLine = `💠 farming quarks for '${MS_NAMES[p.s][p.i]}' ${p.lvl + 1}/${MS_SCALING[p.s][p.i].length}: ${Math.floor(quarks).toLocaleString('en-US')} / ${p.reserve.toLocaleString('en-US')} · reset in ${fmtDur(Math.max(0, farmWait - runTime))}`;
            if (msFarmTarget !== key) {
                pushLog(`💠 farming quarks before '${MS_NAMES[p.s][p.i]}' tier ${p.lvl + 1}: ${Math.floor(quarks).toLocaleString('en-US')} / ${p.reserve.toLocaleString('en-US')}`);
                msFarmTarget = key;
            }
            return;
        }
        if (open.length) msFarmTarget = null;

        // Track progress + stall inside each open window.
        const openKeys = new Set(open.map((p) => p.key));
        for (const key of Object.keys(msWindows)) {
            if (openKeys.has(key)) continue;
            const w = msWindows[key];
            msCloseWindow(key, w, (tiers[w.s]?.[w.i] ?? 0) > w.lvl, 'window closed');
        }
        for (const p of open) {
            const w = msWindows[p.key] || (msWindows[p.key] = {
                peak: 0, lastImprove: Date.now(), need: p.need, lvl: p.lvl, s: p.s, i: p.i,
                startTs: Date.now(), startPeak: 0,
            });
            const val = msValueFromSave(sv, p.s, p.i);
            if (val != null && val > w.peak * 1.02) w.lastImprove = Date.now();
            if (val != null && val > w.peak) w.peak = val;
            if (!w.startPeak && val != null) w.startPeak = val;  // seed on first read
            // Rate-based reachability check: if the counter IS growing but won't
            // reach the target before the window closes, release immediately rather
            // than holding for the full stall timeout (12 min) or window expiry.
            // This prevents the bot from pinning a stage for a target that's hours
            // away at current production rate.
            const elapsed = (Date.now() - w.startTs) / 1000;
            if (elapsed > 30 && val != null && w.peak > w.startPeak) {
                const rate = (w.peak - w.startPeak) / elapsed;  // per second
                const remaining = p.need - w.peak;
                const projectedSec = rate > 0 ? remaining / rate : Infinity;
                const windowRemaining = p.limit - est;
                if (projectedSec > windowRemaining * 1.5) {
                    msRunDead[p.key] = true;
                    msCloseWindow(p.key, w, false, `unreachable at current rate (${fmtDur(projectedSec)} vs ${fmtDur(windowRemaining)} left)`);
                    continue;
                }
            }
            if (Date.now() - w.lastImprove > CONFIG.runStallReleaseMs) {
                msRunDead[p.key] = true;
                msCloseWindow(p.key, w, false, 'stalled');
            }
        }
        const live = open.filter((p) => !msRunDead[p.key]);
        if (!live.length) return;

        // Suppression: hold discharge/vaporize once the ramp share of the
        // tightest open window has elapsed. Collapse intentionally untouched.
        const s1 = live.filter((p) => p.s === 1);
        if (s1.length && est > CONFIG.milestoneRampFrac * Math.min(...s1.map((p) => p.limit))) {
            msCtl.suppressDischarge = true;
        }
        const s2 = live.filter((p) => p.s === 2);
        if (s2.length && est > CONFIG.milestoneRampFrac * Math.min(...s2.map((p) => p.limit))) {
            msCtl.suppressVaporize = true;
        }
        // Hold the stage reset while ANY live milestone window is still open.
        // The safety cap (runHoldMaxMs) catches edge cases where window math is
        // wrong, but the real ceiling is the tightest live window's limit —
        // MS_TIME_BASE ranges up to 16 h (stage 4), far beyond the 3 h cap.
        // Using only the cap caused a 1–13 h gap where the hold released while
        // the window was still open, letting the bot prematurely advance stages.
        const maxWindow = Math.max(...live.map((p) => p.limit));
        msCtl.hold = est < Math.max(CONFIG.runHoldMaxMs / 1000, maxWindow);
        msCtl.holdStageReset = msCtl.hold;

        // HUD line + transition logs for the nearest-deadline live window.
        const next = live.reduce((a, b) => (a.limit < b.limit ? a : b));
        const w = msWindows[next.key];
        msCtl.hudLine = `⛰️ '${MS_NAMES[next.s][next.i]}' ${next.lvl + 1}/${MS_SCALING[next.s][next.i].length}: `
            + `${fmtMsVal(w?.peak)} / ${fmtMsVal(next.need)} · ${fmtDur(Math.max(0, next.limit - est))} left`
            + (msCtl.holdStageReset ? ' · stage held' : '')
            + (msCtl.suppressDischarge ? ' · discharge held' : '')
            + (msCtl.suppressVaporize ? ' · vaporize held' : '');
        if (msCtl.hold && !prev.hold) {
            pushLog(`⛰️ milestone push — '${MS_NAMES[next.s][next.i]}' tier ${next.lvl + 1} within ${fmtDur(next.limit)}`);
        }
        if (msCtl.suppressDischarge && !prev.suppressDischarge) pushLog('⛰️ ramp done — holding discharge to accumulate');
        if (msCtl.suppressVaporize && !prev.suppressVaporize) pushLog('⛰️ ramp done — holding vaporize to accumulate');
    }

    // Console diagnostics: window/backoff state at a glance.
    const milestoneReport = () => {
        const sv = readGameSave();
        const state = {
            config: CONFIG.milestoneAttempts,
            tiers: sv?.milestones ?? null,
            control: msCtl,
            windows: msWindows,
            backoff: Object.fromEntries(Object.entries(msBackoff).map(([k, v]) => [
                k, { fails: v.fails, retryIn: fmtDur(Math.max(0, v.nextTryAt - Date.now()) / 1000) },
            ])),
        };
        console.log('[Fundamental] milestone state:', state);
        return state;
    };

    // BUG FIX: backup the game save to a secondary localStorage key before
    // risky operations (stage/end resets). If a reset corrupts state or the
    // game crashes mid-reset, the player can restore from the backup key.
    const SAVE_BACKUP_KEY = 'fundamentalSaveBackup';
    function backupSave() {
        try {
            const raw = localStorage.getItem('fundamentalSave');
            if (raw) localStorage.setItem(SAVE_BACKUP_KEY, raw);
        } catch (e) {
            console.warn('[Fundamental] could not backup save', e);
        }
    }
    function slowResets() {
        if (CONFIG.doStageReset && resetReady('reset1Button')) {
            if (msCtl.hold) return; // milestone window open (engine logs its own transitions)
            if (msCtl.farmStageReset) {
                const sv = readGameSave();
                const runTimeMs = sv ? estStageTime(sv) * 1000 : 0;
                if (runTimeMs < CONFIG.milestoneQuarkFarmResetWaitMs) return;
            }
            if (!msCtl.farmStageReset && shouldHoldStage5Reset()) {
                if (!eventLog.length || eventLog[eventLog.length - 1].msg !== '⏳ holding Stage 5 reset') {
                    pushLog('⏳ holding Stage 5 reset');
                }
                return;
            }
            backupSave(); // protect against reset corruption
            if (clickIf('reset1Button')) { lastStageResetTs = Date.now(); log('stage reset'); }
        }
        if (CONFIG.doEndReset && resetReady('reset2Button')) {
            backupSave(); // end reset is the riskiest — full vacuum reset
            if (clickIf('reset2Button')) { lastStageResetTs = Date.now(); log('end reset'); }
        }
    }

    // ---- Main loop ------------------------------------------------------------
    let mainTimer = null;
    let lastSlow = 0;
    let lastExport = 0;
    let running = false;

    // The in-game Export grants Strange-quark rewards (exportReward) and THEN downloads the save
    // via a data: anchor. Suppress that download ONLY for the bot's auto-exports (flag-gated), so a
    // manual "Export save" still produces a real backup file.
    let suppressNextDownload = false;
    let suppressDownloadTimer = null;
    let restoreCreateElement = null;
    function restoreExportDownloadSuppressor() {
        if (!restoreCreateElement) return;
        restoreCreateElement();
        restoreCreateElement = null;
    }
    function suppressExportDownloads() {
        if (restoreCreateElement) return;
        const origCreateElement = document.createElement;
        const wrappedCreateElement = function (tagName) {
            const el = origCreateElement.apply(this, arguments);
            if (suppressNextDownload && String(tagName).toLowerCase() === 'a') {
                const origClick = el.click;
                el.click = function () {
                    const href = this.getAttribute('href') || this.href || '';
                    const isDownload = this.hasAttribute('download') || !!this.download;
                    if (suppressNextDownload && isDownload && /^data:text\/plain/i.test(href)) {
                        suppressNextDownload = false;
                        if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                        suppressDownloadTimer = null;
                        restoreExportDownloadSuppressor();
                        return;
                    }
                    return origClick.apply(this, arguments);
                };
            }
            return el;
        };
        document.createElement = wrappedCreateElement;
        restoreCreateElement = () => {
            if (document.createElement === wrappedCreateElement) document.createElement = origCreateElement;
        };
    }
    // Manual save export — clicks the game's Export with the download allowed (real file).
    function exportSaveFile() {
        suppressNextDownload = false;
        restoreExportDownloadSuppressor();
        if (clickIf('export')) pushLog('💾 manual save export');
    }

    function openUpdateUrl() {
        const cacheBustedUrl = `${UPDATE_URL}?v=${encodeURIComponent(BOT_VERSION)}&t=${Date.now()}`;
        window.open(cacheBustedUrl, '_blank', 'noopener,noreferrer');
        pushLog('Opened latest script installer');
    }

    async function copyCollapseLog() {
        const payload = {
            version: BOT_VERSION,
            copiedAt: new Date().toISOString(),
            collapses: collapseLog.slice(),
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            pushLog('📋 collapse log copied');
            const button = $('fbCopyBtn');
            if (button) {
                const oldText = button.querySelector('span')?.textContent;
                const label = button.querySelector('span');
                if (label) label.textContent = 'Copied';
                setTimeout(() => { if (label) label.textContent = oldText || 'Copy log'; }, 1200);
            }
        } catch (error) {
            console.error('[Fundamental] could not copy collapse log', error);
            pushLog('Could not copy collapse log');
        }
    }

    function tick() {
        tickCount++;
        if (document.hidden) { updateHud(); return; }

        // BUG FIX: each phase gets its own try/catch so a failure in one
        // (e.g. a DOM read throwing) doesn't skip the rest of the tick.
        // Previously a single try/catch wrapped everything — one error in
        // fastResets() killed buying, exports, AND the HUD update for that tick.

        const tickPhase = (label, fn) => {
            try { fn(); }
            catch (e) { console.error(`[Fundamental] tick phase "${label}" error`, e); }
        };

        tickPhase('offline-dialog', acceptOfflineDialog);
        tickPhase('milestone', () => { checkGameVersion(); milestoneEngine(); }); // sets msCtl BEFORE the passes below consume it
        tickPhase('settings', () => { applySettings(); configureNativeAutomation(); });
        // Resets BEFORE purchases. Order matters for stage 2: until
        // researchesExtra[2][0] is owned, pending cloud gain is computed from
        // CURRENT (spendable) Drops — buying structures spends them — while
        // the #vaporizationBoostTotal span still shows the value rendered
        // before this tick's purchases. Buying first therefore made the bot
        // fire on an inflated stale reading and vaporize for far fewer clouds
        // than displayed. For every other stage this order is conservative:
        // their projections (collapse mass/stars, merge boost) only RISE with
        // purchases, so a pre-buy read can only delay a trigger, never
        // overshoot it.
        tickPhase('resets', fastResets);
        tickPhase('buy', buyEverything);
        tickPhase('slow-resets', () => {
            const now = Date.now();
            if (now - lastSlow >= CONFIG.slowResetEveryMs) {
                lastSlow = now;
                slowResets();
            }
        });
        tickPhase('export', () => {
            const now = Date.now();
            if (CONFIG.autoExport && activeStage() >= 5 && now - lastExport >= CONFIG.exportEveryMs) {
                lastExport = now;
                suppressNextDownload = true; // suppress only the auto-export's file download (keep reward)
                if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                suppressExportDownloads();
                suppressDownloadTimer = setTimeout(() => {
                    suppressNextDownload = false;
                    suppressDownloadTimer = null;
                    restoreExportDownloadSuppressor();
                }, 1500);
                if (clickIf('export')) {
                    pushLog('📤 export · claimed strange quarks');
                } else {
                    suppressNextDownload = false;
                    if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                    suppressDownloadTimer = null;
                    restoreExportDownloadSuppressor();
                }
            }
        });
        tickPhase('hud', updateHud);
    }

    let startTs = 0;
    let tickCount = 0;

    function start() {
        if (running) return;
        running = true;
        lastSlow = 0;
        startTs = Date.now();
        pushLog('▶ autoplayer started');
        tick();
        mainTimer = setInterval(tick, CONFIG.tickMs);
        updateHud();
        log('started');
    }

    function stop() {
        running = false;
        if (mainTimer) clearInterval(mainTimer);
        mainTimer = null;
        // Hand milestone-owned autos back to the game if an attempt was
        // mid-suppression — a paused script shouldn't leave them disabled.
        if (msCtl.holdStageReset || msCtl.farmStageReset) setToggleOn('toggleAuto0');
        if (msCtl.suppressDischarge) setToggleOn('toggleAuto1');
        if (msCtl.suppressVaporize) setToggleOn('toggleAuto2');
        msCtl = { hold: false, holdStageReset: false, farmStageReset: false, suppressDischarge: false, suppressVaporize: false, hudLine: null };
        suppressNextDownload = false;
        if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
        suppressDownloadTimer = null;
        restoreExportDownloadSuppressor();
        pushLog('⏸ autoplayer stopped');
        updateHud();
        log('stopped');
    }

    // ---- HUD (side panel) -----------------------------------------------------
    let hud = null;
    const el = {}; // cached field elements

    const HUD_CSS = `
    #fbHud{--fb-cyan:#58d9ee;--fb-blue:#2c8ae8;--fb-amber:#f5b642;--fb-green:#4ade80;--fb-red:#fb7185;
        position:fixed;top:16px;right:16px;z-index:2147483600;width:310px;max-height:calc(100vh - 32px);
        font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        font-size:12px;line-height:1.4;color:#edf5ff;user-select:none;border-radius:16px;overflow:hidden;
        background:#07111f;border:1px solid rgba(88,217,238,.55);
        box-shadow:0 18px 48px rgba(0,0,0,.58),0 0 0 1px rgba(44,138,232,.08);}
    #fbHud.min #fbBody{display:none;}
    #fbHead{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:9px;padding:11px 12px;
        cursor:grab;background:#091626;border-bottom:1px solid rgba(88,217,238,.2);}
    #fbHead:active{cursor:grabbing;}
    .fb-logo{width:28px;height:28px;color:var(--fb-cyan);filter:drop-shadow(0 0 5px rgba(88,217,238,.28));}
    .fb-brand{min-width:0;}
    .fb-brand-line{display:flex;align-items:center;gap:7px;min-width:0;}
    .fb-brand b{font-size:13.5px;line-height:1.15;letter-spacing:.1px;color:#f7fbff;white-space:nowrap;}
    .fb-head-state{display:inline-flex;align-items:center;gap:5px;color:#7ee5a1;font-size:10px;font-weight:700;white-space:nowrap;}
    .fb-head-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--fb-green);
        box-shadow:0 0 7px rgba(74,222,128,.7);animation:fbP 1.6s ease-in-out infinite;}
    #fbHud.off .fb-head-state{color:#fda4af;}
    #fbHud.off .fb-head-state::before{background:var(--fb-red);box-shadow:none;animation:none;}
    #fbHud.hidden-tab{border-color:rgba(245,182,66,.72);}
    #fbHud.hidden-tab .fb-head-state{color:#f8cb72;}
    #fbHud.hidden-tab .fb-head-state::before{background:var(--fb-amber);box-shadow:0 0 7px rgba(245,182,66,.65);}
    @keyframes fbP{0%,100%{opacity:1;}50%{opacity:.35;}}
    .fb-head-meta{margin-top:2px;color:#7690aa;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #fbMin{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;color:#a9c1d8;
        background:transparent;cursor:pointer;}
    #fbMin:hover{color:#fff;background:rgba(88,217,238,.1);}
    #fbMin svg{width:15px;height:15px;transition:transform .18s ease;}
    #fbHud.min #fbMin svg{transform:rotate(180deg);}
    #fbBody{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:11px;}
    .fb-section{padding-bottom:11px;border-bottom:1px solid rgba(88,217,238,.16);}
    .fb-eyebrow{margin-bottom:5px;font-size:9px;line-height:1.2;font-weight:800;letter-spacing:1.35px;
        text-transform:uppercase;color:#5dcbe3;}
    .fb-stage{font-size:11px;font-weight:750;letter-spacing:1.2px;color:#b9cce0;text-transform:uppercase;}
    .fb-decision{margin-top:1px;font-size:22px;line-height:1.1;font-weight:760;letter-spacing:-.35px;color:var(--fb-cyan);}
    .fb-decision.ready{color:var(--fb-green);}
    .fb-decision.paused{color:var(--fb-amber);}
    .fb-detail{margin-top:5px;color:#9db1c7;font-size:11px;line-height:1.35;}
    .fb-metrics{display:grid;gap:5px;}
    .fb-metric{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}
    .fb-metric-label{color:#9db1c7;}
    .fb-metric-value{min-width:0;color:#f5f9ff;font-weight:680;text-align:right;font-variant-numeric:tabular-nums;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #fbProgressWrap[hidden]{display:none;}
    .fb-progress-head{display:flex;justify-content:space-between;gap:8px;margin-top:9px;color:#8399b0;font-size:9.5px;}
    .fb-progress-head strong{color:var(--fb-amber);font-weight:720;font-variant-numeric:tabular-nums;}
    .fb-progress{height:5px;margin-top:5px;border-radius:999px;overflow:hidden;background:#162538;border:1px solid #2b4058;}
    .fb-progress>span{display:block;width:0;height:100%;border-radius:inherit;background:var(--fb-cyan);transition:width .25s ease;}
    .fb-progress-values{display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:9px;color:#70879e;
        font-variant-numeric:tabular-nums;}
    .fb-progress-values span:nth-child(2){color:#84e6f1;}
    .fb-progress-values span:last-child{color:#f5bd58;text-align:right;}
    .fb-target-value{font-size:20px;line-height:1.2;font-weight:760;color:var(--fb-amber);font-variant-numeric:tabular-nums;}
    .fb-target-value.ready{color:var(--fb-green);}
    .fb-signal{margin-top:8px;padding-top:8px;border-top:1px solid rgba(88,217,238,.12);color:#94a9bf;font-size:10px;}
    .fb-last-value{color:#c8d7e8;font-size:11px;line-height:1.35;white-space:normal;}
    .fb-actions{display:grid;gap:8px;}
    .fb-primary,.fb-utility{font:inherit;border:0;cursor:pointer;}
    .fb-primary{width:100%;padding:9px 12px;border-radius:9px;color:#fff;font-size:11.5px;font-weight:760;
        background:#1767b6;border:1px solid #3399ed;box-shadow:inset 0 1px 0 rgba(255,255,255,.12);}
    .fb-primary:hover{background:#2177cc;}
    #fbHud.off .fb-primary{background:#17653d;border-color:#39b86d;}
    #fbHud.off .fb-primary:hover{background:#1c7a49;}
    .fb-utility-row{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
    .fb-utility{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;padding:7px 5px;border-radius:8px;
        color:#77d9ea;background:transparent;font-size:10px;}
    .fb-utility:hover{color:#fff;background:rgba(88,217,238,.09);}
    .fb-utility svg{width:14px;height:14px;flex:0 0 auto;}
    #fbUpdateBtn{justify-self:center;padding:4px 7px;color:#7894ad;text-decoration:underline;text-underline-offset:3px;}
    #fbUpdateBtn:hover{color:#9fe8f4;background:transparent;}
    @media(max-width:600px){#fbHud{top:8px;right:8px;width:min(310px,calc(100vw - 16px));max-height:calc(100vh - 16px);}}
    @media(prefers-reduced-motion:reduce){#fbHud *{animation:none!important;transition:none!important;}}
    `;

    function buildHud() {
        const style = document.createElement('style');
        style.textContent = HUD_CSS;
        document.head.appendChild(style);
        hud = document.createElement('div');
        hud.id = 'fbHud';
        hud.innerHTML = `
            <div id="fbHead">
                <svg class="fb-logo" viewBox="0 0 32 32" aria-hidden="true">
                    <circle cx="16" cy="16" r="2.5" fill="currentColor"/>
                    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
                    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(60 16 16)"/>
                    <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(120 16 16)"/>
                </svg>
                <div class="fb-brand">
                    <div class="fb-brand-line"><b>Fundamental Pilot</b><span class="fb-head-state" id="fbHeadState">\u2014</span></div>
                    <div class="fb-head-meta" id="fbHeadMeta">\u2014</div>
                </div>
                <button id="fbMin" type="button" title="Collapse panel" aria-label="Collapse panel" aria-expanded="true">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5 8 5.5l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>
            <div id="fbBody">
                <section class="fb-section">
                    <div class="fb-eyebrow">Current decision</div>
                    <div class="fb-stage" id="fbStage">\u2014</div>
                    <div class="fb-decision" id="fbDecision">\u2014</div>
                    <div class="fb-detail" id="fbDecisionDetail">\u2014</div>
                </section>
                <section class="fb-section">
                    <div class="fb-eyebrow" id="fbMetricHeading">Status</div>
                    <div class="fb-metrics">
                        <div class="fb-metric"><span class="fb-metric-label" id="fbMetricLabel1">\u2014</span><span class="fb-metric-value" id="fbMetricValue1">\u2014</span></div>
                        <div class="fb-metric"><span class="fb-metric-label" id="fbMetricLabel2">\u2014</span><span class="fb-metric-value" id="fbMetricValue2">\u2014</span></div>
                        <div class="fb-metric"><span class="fb-metric-label" id="fbMetricLabel3">\u2014</span><span class="fb-metric-value" id="fbMetricValue3">\u2014</span></div>
                    </div>
                    <div id="fbProgressWrap" hidden>
                        <div class="fb-progress-head"><span id="fbProgressLabel">\u2014</span><strong id="fbProgressPct">\u2014</strong></div>
                        <div class="fb-progress"><span id="fbProgressBar"></span></div>
                        <div class="fb-progress-values"><span id="fbProgressLeft">0</span><span id="fbProgressCurrent">\u2014</span><span id="fbProgressTarget">\u2014</span></div>
                    </div>
                </section>
                <section class="fb-section">
                    <div class="fb-eyebrow" id="fbTargetLabel">Next action</div>
                    <div class="fb-target-value" id="fbTargetValue">\u2014</div>
                    <div class="fb-detail" id="fbTargetDetail">\u2014</div>
                    <div class="fb-signal" id="fbSignal">\u2014</div>
                </section>
                <section class="fb-section">
                    <div class="fb-eyebrow" id="fbLastLabel">Last action</div>
                    <div class="fb-last-value" id="fbLastValue">\u2014</div>
                </section>
                <div class="fb-actions">
                    <button class="fb-primary" id="fbRunBtn" type="button">Pause script</button>
                    <div class="fb-utility-row">
                        <button class="fb-utility" id="fbExportBtn" type="button">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 12v2h10v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            <span>Export save</span>
                        </button>
                        <button class="fb-utility" id="fbCopyBtn" type="button">
                            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="4" width="8" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h6A1.5 1.5 0 0 1 10 2.5V3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
                            <span>Copy log</span>
                        </button>
                    </div>
                    <button class="fb-utility" id="fbUpdateBtn" type="button">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        <span>Install latest</span>
                    </button>
                </div>
            </div>`;
        document.body.appendChild(hud);
        [
            'fbHeadState', 'fbHeadMeta', 'fbStage', 'fbDecision', 'fbDecisionDetail', 'fbMetricHeading',
            'fbMetricLabel1', 'fbMetricValue1', 'fbMetricLabel2', 'fbMetricValue2', 'fbMetricLabel3',
            'fbMetricValue3', 'fbProgressWrap', 'fbProgressLabel', 'fbProgressPct', 'fbProgressBar',
            'fbProgressLeft', 'fbProgressCurrent', 'fbProgressTarget', 'fbTargetLabel', 'fbTargetValue',
            'fbTargetDetail', 'fbSignal', 'fbLastLabel', 'fbLastValue', 'fbRunBtn',
        ].forEach((id) => { el[id] = $(id); });
        $('fbMin').onclick = (e) => {
            e.stopPropagation();
            hud.classList.toggle('min');
            const minimized = hud.classList.contains('min');
            $('fbMin').setAttribute('aria-expanded', minimized ? 'false' : 'true');
            $('fbMin').setAttribute('aria-label', minimized ? 'Expand panel' : 'Collapse panel');
            localStorage.setItem('fbHudMin', minimized ? '1' : '0');
        };
        if (localStorage.getItem('fbHudMin') === '1') hud.classList.add('min');
        $('fbMin').setAttribute('aria-expanded', hud.classList.contains('min') ? 'false' : 'true');
        $('fbRunBtn').onclick = () => (running ? stop() : start());
        $('fbExportBtn').onclick = exportSaveFile;
        $('fbCopyBtn').onclick = copyCollapseLog;
        $('fbUpdateBtn').onclick = openUpdateUrl;
        const pos = localStorage.getItem('fbHudPos');
        if (pos) { try { const p = JSON.parse(pos); hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px'; hud.style.right = 'auto'; } catch (e) { /* ignore */ } }
        makeDraggable($('fbHead'));
        updateHud();
    }

    function makeDraggable(handle) {
        let sx, sy, ox, oy, drag = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button,a')) return;
            drag = true; const r = hud.getBoundingClientRect();
            ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; hud.style.right = 'auto'; e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!drag) return;
            hud.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx)) + 'px';
            hud.style.top = Math.max(0, Math.min(window.innerHeight - 24, oy + e.clientY - sy)) + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!drag) return; drag = false;
            const r = hud.getBoundingClientRect();
            localStorage.setItem('fbHudPos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
        });
    }

    const fmtHudNumber = (value, digits = 4) => {
        if (value == null || !Number.isFinite(value)) return '\u2014';
        const abs = Math.abs(value);
        if ((abs >= 1e6 || (abs > 0 && abs < 0.001))) return value.toExponential(Math.max(1, digits - 1));
        return value.toLocaleString('en-US', { maximumSignificantDigits: digits });
    };
    const fmtHudMass = (value) => value == null ? '\u2014' : `${fmtHudNumber(value, 6)} M\u2609`;
    const footerResource = () => {
        const text = textOf('footerStat1');
        const colon = text.indexOf(':');
        return colon >= 0
            ? { label: text.slice(0, colon).trim() || 'Resource', value: text.slice(colon + 1).trim() || '\u2014' }
            : { label: 'Resource', value: text || '\u2014' };
    };
    const latestEventText = (pattern = null) => {
        const records = pattern ? eventLog.filter((record) => pattern.test(record.msg)) : eventLog;
        return records.length ? records[records.length - 1].msg : 'No action recorded this run';
    };
    function collapseHudModel() {
        const resetText = textOf('reset0Button');
        const projectedMass = /collapse/i.test(resetText) ? numFromText(resetText) : null;
        const bankedMass = readNum('#footerStat2Span');
        const massRatio = projectedMass != null && bankedMass != null && bankedMass > 0
            ? projectedMass / bankedMass
            : null;
        const totalBoost = readNum('#collapseBoostTotal > span');
        const stars = readStarGains();
        const starValues = [stars.s0, stars.s1, stars.s2].map((value) => value || 0);
        const pendingStarSum = starValues.reduce((sum, value) => sum + value, 0);
        const hasStars = pendingStarSum > 0;
        const pendingElements = document.querySelectorAll('[id^="element"].awaiting').length;
        const massTarget = CONFIG.collapseMassMultiplier;
        const massReady = massRatio != null && massRatio >= massTarget;
        const starReady = pendingStarSum >= CONFIG.collapseStarBatch;
        const boostReady = totalBoost != null && totalBoost >= CONFIG.collapseBoost;
        const ready = massReady || starReady || pendingElements > 0 || boostReady;
        let decision = 'Building collapse ROI';
        let decisionDetail = 'Waiting for a worthwhile mass-effect increase.';
        if (totalBoost == null) {
            decision = 'Game auto-collapse';
            decisionDetail = 'The script is observing results; the game owns collapse timing.';
        } else if (ready) {
            decision = starReady ? 'Star batch ready to bank' : 'Collapse trigger ready';
            if (starReady) decisionDetail = `Collapse will bank +${starValues.join(' / ')} stars (batch of ${pendingStarSum}); no mass increase is required.`;
            else if (pendingElements > 0) decisionDetail = `${pendingElements} element${pendingElements === 1 ? '' : 's'} awaiting activation.`;
            else if (massReady) decisionDetail = `Projected mass reached the ${massTarget.toFixed(2)}\u00d7 ROI target.`;
            else decisionDetail = `Total collapse boost reached ${totalBoost.toFixed(2)}\u00d7.`;
        }
        const massProgress = massRatio == null
            ? null
            : Math.max(0, Math.min(1, (massRatio - 1) / (massTarget - 1)));
        const needed = massRatio == null ? null : Math.max(0, massTarget - massRatio);
        // BUG FIX: add a star batch progress bar. When star remnants are
        // pending, the star batch (not mass ROI) is the active trigger path,
        // so show its progress instead — gives the player a visual countdown
        // to the next star-driven collapse.
        const starProgress = hasStars && CONFIG.collapseStarBatch > 0
            ? Math.max(0, Math.min(1, pendingStarSum / CONFIG.collapseStarBatch))
            : null;
        const progressObj = starProgress != null
            ? {
                label: 'Star batch progress',
                pct: `${(starProgress * 100).toFixed(1)}%`,
                width: starProgress * 100,
                left: '0',
                current: `${pendingStarSum}`,
                target: `${CONFIG.collapseStarBatch}`,
            }
            : massProgress == null ? null : {
                label: 'Mass-only ROI progress',
                pct: `${(massProgress * 100).toFixed(1)}% of ROI`,
                width: massProgress * 100,
                left: '1.000×',
                current: `${massRatio.toFixed(3)}×`,
                target: `${massTarget.toFixed(2)}×`,
            };
        const last = [...collapseLog].reverse().find((record) => record.accepted);
        const lastText = last
            ? `#${last.n} \u00b7 ${fmtHudMass(last.bankedMassBefore)} \u2192 ${fmtHudMass(last.bankedMassAfter)} \u00b7 ${last.projectedRatio == null ? 'auto' : `${last.projectedRatio.toFixed(3)}\u00d7`} \u00b7 ${last.reason}`
            : 'Not observed this run';
        const signal = pendingElements > 0
            ? `${pendingElements} element${pendingElements === 1 ? '' : 's'} awaiting activation`
            : hasStars
                ? `Star batch building: ${pendingStarSum} / ${CONFIG.collapseStarBatch} pending (+${starValues.join(' / ')})`
                : 'No star or element trigger pending';
        return {
            decision,
            decisionDetail,
            ready,
            heading: 'Collapse value',
            metrics: [
                ['Banked mass', fmtHudMass(bankedMass)],
                ['Projected mass', fmtHudMass(projectedMass)],
                ['Mass-only ROI', massRatio == null ? 'Game controlled' : `${massRatio.toFixed(3)}\u00d7 / ${massTarget.toFixed(2)}\u00d7`],
            ],
            progress: progressObj,
            targetLabel: totalBoost == null ? 'Collapse owner' : starReady ? 'Star batch ready' : 'Next mass-only collapse',
            targetValue: totalBoost == null ? 'Game controlled' : starReady ? `+${starValues.join(' / ')}` : `${massTarget.toFixed(2)}\u00d7 mass gain`,
            targetDetail: totalBoost == null
                ? 'The game has unlocked its own collapse automation.'
                : starReady
                    ? `Batch of ${pendingStarSum} pending remnants (target ${CONFIG.collapseStarBatch}); no minimum mass gain is required.`
                : needed == null
                    ? 'Waiting for collapse data.'
                    : needed > 0
                        ? `+${needed.toFixed(3)}\u00d7 mass gain needed${projectedMass == null ? '' : `; projected mass is ${fmtHudMass(projectedMass)}`}`
                        : 'Mass-only ROI condition is met',
            signal: starReady ? `Star batch (>=${CONFIG.collapseStarBatch}) bypasses the mass-only ROI floor` : signal,
            lastLabel: 'Last collapse',
            lastValue: lastText,
        };
    }
    function stageHudModel(stage) {
        const resource = footerResource();
        if (stage === 4) return collapseHudModel();
        if (stage === 2) {
            const boost = readNum('#vaporizationBoostTotal > span');
            const target = CONFIG.vaporizeMode === 'fixed' ? CONFIG.vaporizeBoost : CONFIG.vaporizeMinBoost;
            const progress = boost == null ? null : Math.max(0, Math.min(1, boost / target));
            // Banked clouds + pending reset gain, so the boost reading has context.
            // Above 1e4 banked clouds the game softcaps the clouds EFFECT
            // ((clouds-1e4)^0.7+1e4), so a pending gain many times the bank can
            // still be a small boost \u2014 without showing these numbers, the HUD's
            // boost looks contradictory next to the game's cloud counts.
            const bankedClouds = readNum('#footerStat3Span');
            const resetText2 = textOf('reset0Button');
            const pendingClouds = /cloud/i.test(resetText2) ? numFromText(resetText2) : null;
            const softcapped = bankedClouds != null && bankedClouds > 1e4;
            return {
                decision: boost != null && boost >= target ? 'Vaporizing now' : 'Building vapor boost',
                decisionDetail: CONFIG.vaporizeMode === 'fixed' ? 'Waiting for the fixed high-ROI reset point.' : 'Following the adaptive growth-rate peak.',
                ready: boost != null && boost >= target,
                heading: 'Vaporization',
                metrics: [
                    ['Banked clouds', bankedClouds == null ? '\u2014' : fmtHudNumber(bankedClouds, 6)],
                    ['Pending gain', pendingClouds == null ? '\u2014' : `+${fmtHudNumber(pendingClouds, 6)}`],
                    ['Current boost', boost == null ? '\u2014' : `${boost.toFixed(2)}\u00d7 / ${target.toFixed(2)}\u00d7`],
                ],
                progress: progress == null ? null : { label: 'Boost vs. reset target', pct: `${(progress * 100).toFixed(1)}%`, width: progress * 100, left: '1.00\u00d7', current: `${boost.toFixed(2)}\u00d7`, target: `${target.toFixed(2)}\u00d7` },
                targetLabel: 'Next vaporization',
                targetValue: `${target.toFixed(2)}\u00d7 boost`,
                targetDetail: boost == null ? 'Waiting for the boost stat.' : `+${Math.max(0, target - boost).toFixed(2)}\u00d7 boost needed`,
                signal: softcapped
                    ? `Cycle ${vapLastTs ? fmtDur((Date.now() - vapLastTs) / 1000) : '\u2014'} \u00b7 clouds effect softcapped above 1e4 \u2014 boost, not cloud count, is the trigger`
                    : `Cycle time ${vapLastTs ? fmtDur((Date.now() - vapLastTs) / 1000) : '\u2014'}`,
                lastLabel: 'Last vaporization',
                lastValue: latestEventText(/vaporize/i),
            };
        }
        if (stage === 5) {
            const boost = readNum('#mergeBoostTotal > span');
            const target = CONFIG.mergeBoost;
            const progress = boost == null ? null : Math.max(0, Math.min(1, boost / target));
            const needMerge = boost != null && boost >= CONFIG.mergeMinBoost;
            const inGrace = stage5HoldStart ? ((Date.now() - stage5HoldStart) / 1000) : 0;
            const graceRemaining = Math.max(0, (CONFIG.stage5HoldGraceMs / 1000) - inGrace);
            const decision = boost != null && boost >= target
                ? 'Merge trigger ready'
                : needMerge
                    ? 'Merge approaching'
                    : graceRemaining > 0
                        ? 'Building galaxies'
                        : 'Farming strange quarks';
            const decisionDetail = boost != null && boost >= target
                ? 'Merging now for a production multiplier.'
                : needMerge
                    ? 'Holding Intergalactic while merge boost builds toward 2.0\u00d7.'
                    : graceRemaining > 0
                        ? `Grace period for initial building (${graceRemaining.toFixed(0)}s remaining).`
                        : 'Merge boost is below the anti-hang floor; resetting to farm quarks.';
            return {
                decision,
                decisionDetail,
                ready: boost != null && boost >= target,
                heading: 'Intergalactic',
                metrics: [
                    [resource.label, resource.value],
                    ['Merge boost', boost == null ? 'Game controlled' : `${boost.toFixed(2)}\u00d7`],
                    ['Stage policy', boost == null ? 'Game auto' : needMerge ? 'Hold' : 'Loop'],
                ],
                progress: progress == null ? null : { label: 'Boost vs. merge target', pct: `${(progress * 100).toFixed(1)}%`, width: progress * 100, left: '1.00\u00d7', current: `${boost.toFixed(2)}\u00d7`, target: `${target.toFixed(2)}\u00d7` },
                targetLabel: 'Next merge',
                targetValue: boost == null ? 'Game controlled' : `${target.toFixed(2)}\u00d7 boost`,
                targetDetail: boost == null ? 'The game has unlocked its own merge automation.' : `+${Math.max(0, target - boost).toFixed(2)}\u00d7 boost needed`,
                signal: boost == null
                    ? 'Game owns merge timing'
                    : needMerge
                        ? 'Merge boost is above the anti-hang floor — holding'
                        : graceRemaining > 0
                            ? `Grace period: ${graceRemaining.toFixed(0)}s until quark loop`
                            : 'Stage reset loops remain enabled',
                lastLabel: 'Last action',
                lastValue: latestEventText(/merge|stage|export/i),
            };
        }
        const resetText = textOf('reset0Button');
        const ready = resetReady('reset0Button');
        const labels = {
            1: ['Buying and discharging', 'Keeping the Microworld production loop moving.', 'Discharge check'],
            3: ['Climbing accretion ranks', 'Buying structures and taking each available rank.', 'Rank requirement'],
            6: ['Game automation active', 'High-stage resets remain under game control.', 'Reset status'],
        };
        const fallback = labels[stage] || ['Reading game state', 'Waiting for a recognized stage.', 'Reset status'];
        return {
            decision: fallback[0],
            decisionDetail: fallback[1],
            ready,
            heading: 'Stage status',
            metrics: [[resource.label, resource.value], ['Reset', ready ? 'Ready' : 'Waiting'], ['Bot uptime', running && startTs ? fmtDur((Date.now() - startTs) / 1000) : '\u2014']],
            progress: null,
            targetLabel: fallback[2],
            targetValue: ready ? 'Ready now' : 'Waiting',
            targetDetail: resetText || 'No reset information available.',
            signal: CONFIG.enableGameAutomation ? 'Game automation is enabled' : 'Game automation is disabled',
            lastLabel: 'Last action',
            lastValue: latestEventText(),
        };
    }
    function updateHud() {
        if (!hud) return;
        const s = activeStage();
        const tabHidden = running && document.hidden;
        const stageName = STAGE_NAMES[s] || 'Unknown stage';
        const model = stageHudModel(s);
        hud.classList.toggle('off', !running);
        hud.classList.toggle('hidden-tab', tabHidden);
        el.fbHeadState.textContent = tabHidden ? 'Tab hidden' : running ? 'Running' : 'Paused';
        el.fbHeadMeta.textContent = `v${BOT_VERSION} \u00b7 ${stageName}`;
        el.fbStage.textContent = stageName;
        el.fbDecision.textContent = tabHidden ? 'Tab is paused' : !running ? 'Script paused' : model.decision;
        el.fbDecision.className = `fb-decision${tabHidden || !running ? ' paused' : model.ready ? ' ready' : ''}`;
        el.fbDecisionDetail.textContent = tabHidden
            ? 'Return this tab to the foreground so the game clock can resume.'
            : !running
                ? 'No purchases or resets will be attempted until resumed.'
                : model.decisionDetail;
        el.fbMetricHeading.textContent = model.heading;
        model.metrics.forEach(([label, value], index) => {
            el['fbMetricLabel' + (index + 1)].textContent = label;
            el['fbMetricValue' + (index + 1)].textContent = value;
        });
        el.fbProgressWrap.hidden = !model.progress;
        if (model.progress) {
            el.fbProgressLabel.textContent = model.progress.label;
            el.fbProgressPct.textContent = model.progress.pct;
            el.fbProgressBar.style.width = `${model.progress.width}%`;
            el.fbProgressLeft.textContent = model.progress.left;
            el.fbProgressCurrent.textContent = model.progress.current;
            el.fbProgressTarget.textContent = model.progress.target;
        }
        el.fbTargetLabel.textContent = model.targetLabel;
        el.fbTargetValue.textContent = model.targetValue;
        el.fbTargetValue.className = `fb-target-value${model.ready ? ' ready' : ''}`;
        el.fbTargetDetail.textContent = model.targetDetail;
        // A live milestone attempt outranks the stage's default signal line.
        el.fbSignal.textContent = msCtl.hudLine || model.signal;
        el.fbLastLabel.textContent = model.lastLabel;
        el.fbLastValue.textContent = model.lastValue;
        el.fbRunBtn.textContent = running ? 'Pause script' : 'Resume script';
    }

    // ---- Boot -----------------------------------------------------------------
    function boot() {
        if (!exists('makeAllFooter')) { setTimeout(boot, 500); return; } // wait for game UI
        // BUG FIX: validate strangenessTargets config at startup. A missing or
        // non-array value silently disables the saving-window system, leaving
        // the player wondering why high-value targets aren't being pursued.
        if (CONFIG.smartStrangeness) {
            const targets = Array.isArray(CONFIG.strangenessTargets) ? CONFIG.strangenessTargets : null;
            if (!targets || targets.length === 0) {
                console.warn('[Fundamental] smartStrangeness is enabled but strangenessTargets is missing, empty, or not an array. ' +
                    'The saving-window system will be inactive — only current-stage-first buying will run. ' +
                    'Set CONFIG.strangenessTargets to an array of strangeness element IDs (e.g. ["strange7Stage3"]) to enable targeted saving.');
                pushLog('⚠️ strangenessTargets not configured — saving windows inactive');
            } else {
                // Verify each target ID exists in the DOM (game may have added/renamed)
                const missing = targets.filter((id) => !$(id));
                if (missing.length) {
                    console.warn(`[Fundamental] strangenessTargets IDs not found in DOM: ${missing.join(', ')}. ` +
                        'These may be stage-gated (appear after a stage unlock) or renamed in a game update.');
                }
            }
        }
        buildHud();
        // expose manual controls for the console
        window.FundamentalBot = {
            version: BOT_VERSION,
            start,
            stop,
            tick,
            CONFIG,
            report,
            collapseReport,
            milestoneReport,
            cycles: cycleLog,
            collapses: collapseLog,
            log: eventLog,
            exportSave: exportSaveFile,
            copyCollapseLog,
            installLatest: openUpdateUrl,
        };
        if (CONFIG.autoStart) start();
        console.log(`[Fundamental] Autoplayer v${BOT_VERSION} loaded. Collapse telemetry: window.FundamentalBot.collapseReport().`);
    }

    boot();
})();
