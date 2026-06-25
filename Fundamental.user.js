// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.11.4
// @description  Automatically plays awWhy's "Fundamental" idle game by driving its DOM controls: buys all structures/upgrades/strangeness, performs resets when ready, and enables the game's own automation + auto-stage switching.
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
 * Even hidden buttons (on inactive tabs) still fire their click listeners, so we
 * never need to switch tabs to act.
 *
 * Strategy:
 *   1. One-time-ish setup (re-checked cheaply every tick, only acts when needed):
 *        - set every confirmation toggle (toggleConfirm0..7) to "None" so resets
 *          never pop a blocking dialog,
 *        - turn ON the game's own automation (toggleAll, toggleAuto0..11,
 *          toggleVerse0) and auto-stage-switch (toggleNormal0). These do nothing
 *          until the matching "strangeness" upgrades are bought, at which point the
 *          game auto-runs that part for us optimally.
 *   2. Every tick:
 *        - buy all structures        -> #makeAllFooter
 *        - buy all upgrades/research -> #createAllFooter
 *        - buy all strangeness       -> #createAllStrangeness
 *        - discharge / vaporize / .. -> #reset0Button (when ready)
 *   3. On a slower cadence: attempt stage reset (#reset1Button) and end reset
 *      (#reset2Button) when their button text says they're ready.
 *   4. Auto-accept the "offline time" dialog that pops up whenever the tab
 *      regains focus, so it never blocks unattended play.
 *
 * Readiness is read from button text because these reset buttons are never marked
 * .disabled — when not ready they read "Next goal is ...", "Requires ...", etc.
 *
 * IMPORTANT — keep the tab in the FOREGROUND:
 *   Like most idle games, Fundamental advances production on requestAnimationFrame,
 *   which the browser FREEZES while the tab is hidden/backgrounded. The bot keeps
 *   clicking, but the game clock only ticks while its tab is visible. For
 *   continuous play, leave the game in its own focused window/tab. Brief switches
 *   are fine — on return the game grants "offline time" (auto-accepted here).
 */

(function () {
    'use strict';

    const BOT_VERSION = '1.11.4';
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
        vaporizeMinBoost: 1.5,  // adaptive only: never fire below this boost.
        vaporizePeakDrop: 0.05, // adaptive only: fire once ln(boost)/elapsed drops this fraction
                                // below its running max.
        logCycles: true,        // record each vaporization cycle for tuning/validation.
                                // Inspect via window.FundamentalBot.report().
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
        stage5HoldMaxMs: 1200000, // if only basic Stage 5 building work is visible, hold up to 20m
                                // before allowing a quark loop. Merge-ready/merge-boost states hold
                                // indefinitely until mergeStep or the game's own automation handles it.
        collapseBoost: 2.5,     // stage 4: collapse immediately when the production boost
                                // (#collapseBoostTotal) reaches this multiple — a clearly-good
                                // collapse is always worth taking now rather than waiting out the
                                // anti-hang timer. Early stage-4 boosts hover low (~1-1.3), so most
                                // collapses come from the anti-hang below until mass/stars scale up.
        collapseMaxWaitMs: 90000, // anti-hang: also collapse after this long at a modest boost, so
                                // collapse-gated elements and mass-locked upgrades keep unlocking
                                // (a pure boost gate can stall when a collapse is what's needed).
        collapseMinBoost: 1.3,  // floor for the anti-hang collapse — don't fire a worthless reset.
        collapseOnElement: true, // collapse ASAP when a new element is pending (awaiting activation)
                                // — elements only activate on collapse and their boost isn't in
                                // #collapseBoostTotal, so grabbing them fast is high-ROI.
        collapseElementGapMs: 3000, // min gap between element-triggered collapses (avoids a double
                                // fire during the render lag before the element flips to "created").
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
        strangenessTargets: ['strange6Stage4', 'strange7Stage4'],
                                // buy these strangeness upgrades NEXT, in order, holding others
                                // while saving quarks. Default = Interstellar Auto Structures first,
                                // then "Elements no longer require Collapse". Seeded route tests from
                                // a real Submerged save showed this pair beats default cost-order
                                // spending for repeated stage-4 pushes.
        strangenessTarget: null, // legacy single-target override; use strangenessTargets above.
        strangenessTargetTimeoutMs: 600000, // stop holding after 10 min if it can't be bought
                                // because it appears locked. Expensive-but-unlocked targets are held
                                // indefinitely; spending around them was slower in seeded tests.
        verbose: false,         // log every action to console
    };

    const CONFIG_STORAGE_PREFIX = 'fbConfig:';
    const loadSavedBool = (key) => {
        try {
            const saved = localStorage.getItem(CONFIG_STORAGE_PREFIX + key);
            return saved === null ? CONFIG[key] : saved === '1';
        } catch (e) {
            return CONFIG[key];
        }
    };
    CONFIG.autoExport = loadSavedBool('autoExport');
    CONFIG.smartStrangeness = loadSavedBool('smartStrangeness');
    CONFIG.collapseOnElement = loadSavedBool('collapseOnElement');

    // Text on a reset button that means "not ready yet".
    const NOT_READY = /requires|next goal|reach|need|self[- ]?made|locked|unlock|first|to unlock/i;

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
        return i > 0 ? i : 1;
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
    function setConfigFlag(key, value) {
        CONFIG[key] = !!value;
        try { localStorage.setItem(CONFIG_STORAGE_PREFIX + key, CONFIG[key] ? '1' : '0'); } catch (e) { /* ignore */ }
        pushLog(`${key} ${CONFIG[key] ? 'ON' : 'OFF'}`);
        if (key === 'autoExport' && !CONFIG[key]) {
            suppressNextDownload = false;
            if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
            suppressDownloadTimer = null;
            lastExport = Date.now();
        } else if (key === 'smartStrangeness' && !CONFIG[key]) {
            strangeTargetStart = 0;
        } else if (key === 'collapseOnElement' && !CONFIG[key]) {
            collapseLastTs = Date.now();
        }
        updateHud();
    }
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
        if (!box || box.offsetParent === null) return; // no dialog showing
        const msg = textOf('alertText');
        if (/offline time/i.test(msg)) clickIf('alertConfirm');
    }

    // ---- Setup pass (cheap, idempotent) --------------------------------------
    function applySettings() {
        if (CONFIG.setConfirmNone) {
            for (let i = 0; i <= 7; i++) setConfirmNone('toggleConfirm' + i);
        }
        if (CONFIG.enableGameAutomation) {
            setToggleOn('toggleAll');                 // master building automation
            setToggleOn('toggleVerse0');              // universe automation
            for (let i = 0; i <= 11; i++) setToggleOn('toggleAuto' + i); // discharge/stage/upgrade autos
            setToggleOn('toggleNormal0');             // auto-switch active stage
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
    // strangenessTargets: upgrades to buy NEXT — the bot HOLDS other strangeness so quarks
    // accumulate for the first unowned target. Default route buys Interstellar Auto Structures
    // before "Elements no longer require Collapse"; seeded tests from a real Submerged save showed
    // that getting stage-4 structures automated first speeds repeated Interstellar pushes. Resumes
    // normal buying once targets are owned. A timeout only releases a target if it appears locked;
    // expensive-but-unlocked route targets are worth saving for. The quark-gain multiplier is always
    // pursued.
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
    function buyStrangenessSmart() {
        clickIf('strange3Stage5'); // highest-ROI quark-gain multiplier — always pursue (compounds income)
        const target = currentStrangenessTarget();
        if (target) {
            if (!strangeTargetStart) strangeTargetStart = Date.now();
            clickIf(target); // buy it the instant quarks allow
            const targetText = textOf(target);
            const looksLocked = /locked|unlock|requires|reach|need/i.test(targetText);
            if (!looksLocked || Date.now() - strangeTargetStart <= CONFIG.strangenessTargetTimeoutMs) return; // hold the rest
        } else { strangeTargetStart = 0; }
        clickIf('strange4Stage5'); // Intergalactic collapse-immunity / enables auto-upgrade there
        const cur = activeStage();
        const order = [cur];
        for (let s = 6; s >= 1; s--) if (s !== cur) order.push(s);
        for (const s of order) for (let i = 1; i <= 10; i++) clickIf('strange' + i + 'Stage' + s);
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
        if (CONFIG.logCycles && elapsed > 0 && boost && boost > 1) {
            const rho = Math.log(boost) / elapsed; // realized growth rate (1/s) — the objective
            const rec = {
                n: ++vapCycleN,
                elapsed: +elapsed.toFixed(2),
                boost: +boost.toFixed(3),
                rho: +rho.toFixed(5),                       // ln(boost)/elapsed = what we maximize
                peakRho: +vapPeakScore.toFixed(5),          // best ρ seen this cycle (adaptive only)
                eff: vapPeakScore > 0 ? +(rho / vapPeakScore).toFixed(3) : null, // ρ_fire / ρ_peak
                clouds: readNum('#footerStat3Span'),        // clouds before this reset
                cloudsGain: numFromText(textOf('reset0Button')), // "Reset for X Clouds"
            };
            cycleLog.push(rec);
            if (cycleLog.length > 500) cycleLog.shift();
            console.log(`[Fundamental] vap #${rec.n}: ${rec.boost}x in ${rec.elapsed}s | ρ=${rec.rho}/s peak=${rec.peakRho} eff=${rec.eff} | +${rec.cloudsGain} clouds`);
        }
        pushLog(`💨 vaporize ${boost ? boost.toFixed(2) : '?'}× · ${elapsed.toFixed(1)}s`);
        clickIf('reset0Button');
        resetVaporTracking();
    };

    function vaporizeStep() {
        if (!vapLastTs) vapLastTs = Date.now();
        const boost = readNum('#vaporizationBoostTotal > span');
        if (boost === null) return;

        if (CONFIG.vaporizeMode === 'fixed') {
            if (boost >= CONFIG.vaporizeBoost) doVaporize(boost);
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
    // Collapse is unlike vaporization: elements only unlock ON a collapse and some
    // upgrades are gated behind mass thresholds, so a pure boost gate can stall when
    // a collapse is exactly what's needed to progress. Dual trigger: fire on a strong
    // production boost, OR periodically (anti-hang) at a modest boost so collapse-gated
    // elements / mass-locked upgrades keep unlocking. #collapseBoostTotal disappears
    // once the game's own auto-collapse takes over (strangeness lvl 3) — then we leave
    // it to the game. (Elements that are "ready" are auto-bought by the collapse itself.)
    let collapseLastTs = 0;
    function collapseStep() {
        if (!collapseLastTs) collapseLastTs = Date.now();
        if (!/collapse/i.test(textOf('reset0Button'))) return; // not the collapse reset / not actionable
        const boost = readNum('#collapseBoostTotal > span'); // null when the game auto-handles it
        const elapsed = (Date.now() - collapseLastTs) / 1000;
        // A pending element (#elementN has class "awaiting") only activates ON a collapse, and its
        // permanent boost is NOT included in #collapseBoostTotal (elements apply during the reset),
        // so the boost reading understates the true value. Collapse promptly to bank it. Self-
        // disabling: with the "elements don't need collapse" strangeness, elements skip "awaiting".
        const elementPending = CONFIG.collapseOnElement && !!document.querySelector('[id^="element"].awaiting');
        let fire = false;
        if (elementPending && elapsed >= CONFIG.collapseElementGapMs / 1000) fire = true;
        else if (boost != null && boost >= CONFIG.collapseBoost) fire = true;
        else if (elapsed >= CONFIG.collapseMaxWaitMs / 1000 && (boost == null || boost >= CONFIG.collapseMinBoost)) fire = true;
        if (fire) {
            clickIf('reset0Button');
            collapseLastTs = Date.now();
            pushLog('💥 collapse' + (elementPending ? ' (element)' : '') + (boost != null ? ' ' + boost.toFixed(2) + '×' : ''));
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
            mergeLastTs = 0;
            return;
        }
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
        if (/merge/i.test(textOf('reset0Button')) && (resetReady('reset0Button') || mergeBoost != null)) return true;
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
        if (/merge/i.test(textOf('reset0Button')) && (resetReady('reset0Button') || mergeBoost != null)) return true;
        return Date.now() - stage5HoldStart <= CONFIG.stage5HoldMaxMs;
    }

    // ---- Reset pass -----------------------------------------------------------
    // reset0 = discharge(1) / vaporization(2) / rank(3) / collapse(4) / merge(5) / nucleation(6).
    // Each stage's reset has a very different cost/benefit, so they are handled
    // individually rather than spammed uniformly.
    let prevStage = 0;
    function fastResets() {
        const s = activeStage();
        if (s !== 2 && prevStage === 2) resetVaporTracking(); // left stage 2 — start fresh on return
        if (s !== 4 && prevStage === 4) collapseLastTs = 0;   // left stage 4 — reset collapse cadence
        if (s !== 5 && prevStage === 5) mergeLastTs = 0;      // left stage 5 — reset merge cadence
        if (s !== 5 && prevStage === 5) stage5HoldStart = 0;   // left stage 5 — reset stage-reset hold
        if (s !== prevStage && prevStage !== 0) pushLog(`🪐 stage → ${STAGE_NAMES[s] || s}`);
        prevStage = s;

        if (s === 1) {
            // Discharge: cheap and the regain is always beneficial — the standard
            // early strategy is to discharge constantly. (Don't gate on the label:
            // it can read "Next goal is X Energy" even when a discharge is available.)
            clickIf('reset0Button');
        } else if (s === 2) {
            vaporizeStep();
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

    function slowResets() {
        if (CONFIG.doStageReset && resetReady('reset1Button')) {
            if (shouldHoldStage5Reset()) {
                if (!eventLog.length || eventLog[eventLog.length - 1].msg !== '⏳ holding Stage 5 reset') {
                    pushLog('⏳ holding Stage 5 reset');
                }
                return;
            }
            clickIf('reset1Button'); log('stage reset');
        }
        if (CONFIG.doEndReset && resetReady('reset2Button')) {
            clickIf('reset2Button'); log('end reset');
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
    function suppressExportDownloads() {
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (suppressNextDownload && this.download && /^data:text\/plain/i.test(this.getAttribute('href') || '')) {
                suppressNextDownload = false;
                if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                suppressDownloadTimer = null;
                return;
            }
            return origClick.apply(this, arguments);
        };
    }
    // Manual save export — clicks the game's Export with the download allowed (real file).
    function exportSaveFile() {
        suppressNextDownload = false;
        if (clickIf('export')) pushLog('💾 manual save export');
    }

    function openUpdateUrl() {
        window.open(UPDATE_URL, '_blank', 'noopener,noreferrer');
        pushLog('Opened update page');
    }

    function tick() {
        try {
            tickCount++;
            acceptOfflineDialog();
            applySettings();
            buyEverything();
            fastResets();
            const now = Date.now();
            if (now - lastSlow >= CONFIG.slowResetEveryMs) {
                lastSlow = now;
                slowResets();
            }
            if (CONFIG.autoExport && activeStage() >= 5 && now - lastExport >= CONFIG.exportEveryMs) {
                lastExport = now;
                suppressNextDownload = true; // suppress only the auto-export's file download (keep reward)
                if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                suppressDownloadTimer = setTimeout(() => {
                    suppressNextDownload = false;
                    suppressDownloadTimer = null;
                }, 1500);
                if (clickIf('export')) {
                    pushLog('📤 export · claimed strange quarks');
                } else {
                    suppressNextDownload = false;
                    if (suppressDownloadTimer) clearTimeout(suppressDownloadTimer);
                    suppressDownloadTimer = null;
                }
            }
            updateHud();
        } catch (e) {
            console.error('[Fundamental] tick error', e);
        }
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
        pushLog('⏸ autoplayer stopped');
        updateHud();
        log('stopped');
    }

    // ---- HUD (side panel) -----------------------------------------------------
    let hud = null;
    const el = {}; // cached field elements

    const HUD_CSS = `
    #fbHud{position:fixed;top:12px;right:12px;z-index:2147483600;width:238px;font-family:'Inter',system-ui,sans-serif;
        font-size:12px;color:#e8edf6;user-select:none;border-radius:14px;overflow:hidden;
        background:linear-gradient(165deg,rgba(20,18,34,.93),rgba(10,11,20,.96));
        border:1px solid rgba(120,170,255,.28);backdrop-filter:blur(12px);box-shadow:0 10px 30px rgba(0,0,0,.5);}
    #fbHud.min #fbBody{display:none;}
    #fbHead{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:grab;
        background:linear-gradient(90deg,rgba(120,150,255,.18),transparent 70%);border-bottom:1px solid rgba(255,255,255,.07);}
    #fbHead:active{cursor:grabbing;}
    #fbHud .d{width:9px;height:9px;border-radius:50%;background:#4ade80;box-shadow:0 0 9px #4ade80;flex:0 0 auto;animation:fbP 1.5s ease-in-out infinite;}
    #fbHud.off .d{background:#f87171;box-shadow:0 0 9px #f87171;animation:none;}
    @keyframes fbP{0%,100%{opacity:1;}50%{opacity:.35;}}
    #fbHead b{font-weight:700;flex:1;letter-spacing:.2px;font-size:12.5px;color:#eaf2ff;}
    #fbMin{cursor:pointer;color:#9fb6d6;padding:0 6px;border-radius:6px;}
    #fbMin:hover{color:#fff;background:rgba(255,255,255,.1);}
    #fbBody{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;}
    .fb-t{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#7fa8d8;opacity:.85;margin-bottom:1px;}
    .fb-r{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}
    .fb-k{color:#9fb6d6;flex:0 0 auto;}
    .fb-v{color:#fff;font-weight:600;text-align:right;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}
    .fb-sep{height:1px;background:rgba(255,255,255,.08);margin:2px 0;}
    .fb-tg{display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:3px 0;}
    .fb-tg:hover .fb-k{color:#cfe0ff;}
    .fb-pill{font-size:9.5px;font-weight:700;letter-spacing:.5px;padding:2px 10px;border-radius:20px;}
    .fb-pill.on{background:rgba(74,222,128,.16);color:#7fdca0;border:1px solid rgba(74,222,128,.35);}
    .fb-pill.off{background:rgba(248,113,113,.12);color:#f0a0a0;border:1px solid rgba(248,113,113,.3);}
    .fb-btn{margin-top:4px;text-align:center;cursor:pointer;padding:7px;border-radius:9px;font-size:11.5px;font-weight:600;
        color:#cfe0ff;background:rgba(120,170,255,.1);border:1px solid rgba(120,170,255,.3);}
    .fb-btn:hover{background:rgba(120,170,255,.22);color:#fff;}
    `;

    const setPill = (elm, on) => { elm.textContent = on ? 'ON' : 'OFF'; elm.className = 'fb-pill ' + (on ? 'on' : 'off'); };

    function buildHud() {
        const style = document.createElement('style');
        style.textContent = HUD_CSS;
        document.head.appendChild(style);
        hud = document.createElement('div');
        hud.id = 'fbHud';
        hud.innerHTML = `
            <div id="fbHead"><span class="d"></span><b>\u269b Fundamental Bot</b><span id="fbMin" title="Collapse / expand">\u25be</span></div>
            <div id="fbBody">
                <div class="fb-r"><span class="fb-k">State</span><span class="fb-v" id="fbState">\u2014</span></div>
                <div class="fb-r"><span class="fb-k">Uptime</span><span class="fb-v" id="fbUp">\u2014</span></div>
                <div class="fb-r"><span class="fb-k">Stage</span><span class="fb-v" id="fbStage">\u2014</span></div>
                <div class="fb-r"><span class="fb-k">Version</span><span class="fb-v" id="fbVer">\u2014</span></div>
                <div class="fb-r"><span class="fb-k" id="fbResK">Resource</span><span class="fb-v" id="fbResV">\u2014</span></div>
                <div class="fb-r"><span class="fb-k" id="fbRoiK">ROI</span><span class="fb-v" id="fbRoiV">\u2014</span></div>
                <div class="fb-r"><span class="fb-k">Goal</span><span class="fb-v" id="fbGoal">\u2014</span></div>
                <div class="fb-r"><span class="fb-k">Strange tgt</span><span class="fb-v" id="fbTgt">\u2014</span></div>
                <div class="fb-sep"></div>
                <div class="fb-t">Toggles</div>
                <div class="fb-tg" id="fbTgScript"><span class="fb-k">Script</span><span class="fb-pill" id="fbPScript">\u2014</span></div>
                <div class="fb-tg" id="fbTgExport"><span class="fb-k">Auto-export</span><span class="fb-pill" id="fbPExport">\u2014</span></div>
                <div class="fb-tg" id="fbTgStrange"><span class="fb-k">Smart strangeness</span><span class="fb-pill" id="fbPStrange">\u2014</span></div>
                <div class="fb-tg" id="fbTgElem"><span class="fb-k">Collapse on element</span><span class="fb-pill" id="fbPElem">\u2014</span></div>
                <div class="fb-btn" id="fbExportBtn">\ud83d\udcbe Export save</div>
                <div class="fb-btn" id="fbUpdateBtn">Update script</div>
            </div>`;
        document.body.appendChild(hud);
        ['fbState', 'fbUp', 'fbStage', 'fbVer', 'fbResK', 'fbResV', 'fbRoiK', 'fbRoiV', 'fbGoal', 'fbTgt',
         'fbPScript', 'fbPExport', 'fbPStrange', 'fbPElem'].forEach((id) => { el[id] = $(id); });
        $('fbMin').onclick = (e) => { e.stopPropagation(); hud.classList.toggle('min'); localStorage.setItem('fbHudMin', hud.classList.contains('min') ? '1' : '0'); };
        if (localStorage.getItem('fbHudMin') === '1') hud.classList.add('min');
        $('fbTgScript').onclick = () => (running ? stop() : start());
        $('fbTgExport').onclick = () => setConfigFlag('autoExport', !CONFIG.autoExport);
        $('fbTgStrange').onclick = () => setConfigFlag('smartStrangeness', !CONFIG.smartStrangeness);
        $('fbTgElem').onclick = () => setConfigFlag('collapseOnElement', !CONFIG.collapseOnElement);
        $('fbExportBtn').onclick = exportSaveFile;
        $('fbUpdateBtn').onclick = openUpdateUrl;
        const pos = localStorage.getItem('fbHudPos');
        if (pos) { try { const p = JSON.parse(pos); hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px'; hud.style.right = 'auto'; } catch (e) { /* ignore */ } }
        makeDraggable($('fbHead'));
        updateHud();
    }

    function makeDraggable(handle) {
        let sx, sy, ox, oy, drag = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.id === 'fbMin') return;
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

    function updateHud() {
        if (!hud) return;
        const s = activeStage();
        const sw = $('stageWord');
        hud.classList.toggle('off', !running);
        el.fbState.textContent = running ? 'running' : 'paused';
        el.fbState.style.color = running ? '#7fdca0' : '#f0a0a0';
        el.fbUp.textContent = running && startTs ? fmtDur((Date.now() - startTs) / 1000) : '\u2014';
        el.fbStage.textContent = sw ? sw.textContent.trim() : (STAGE_NAMES[s] || '\u2014');
        el.fbVer.textContent = 'v' + BOT_VERSION;
        if (sw) el.fbStage.style.color = getComputedStyle(sw).color;
        const f1 = textOf('footerStat1'); const ci = f1.indexOf(':');
        el.fbResK.textContent = ci >= 0 ? f1.slice(0, ci).trim() : 'Resource';
        el.fbResV.textContent = ci >= 0 ? f1.slice(ci + 1).trim() : (f1 || '\u2014');
        el.fbGoal.textContent = textOf('reset0Button') || '\u2014';
        let roiK = 'ROI', roiV = '\u2014';
        if (s === 2) { roiK = 'Vap boost'; const b = readNum('#vaporizationBoostTotal > span'); roiV = b != null ? b.toFixed(2) + '\u00d7' : '\u2014'; }
        else if (s === 4) { roiK = 'Collapse boost'; const b = readNum('#collapseBoostTotal > span'); roiV = b != null ? b.toFixed(2) + '\u00d7' : '\u2014'; }
        else if (s === 5) { roiK = 'Merge boost'; const b = readNum('#mergeBoostTotal > span'); roiV = b != null ? b.toFixed(2) + '\u00d7' : '\u2014'; }
        el.fbRoiK.textContent = roiK; el.fbRoiV.textContent = roiV;
        const tgt = currentStrangenessTarget();
        el.fbTgt.textContent = tgt ? (($(tgt) && (textOf(tgt).match(/\d[\d.eE+]*\s*\/\s*\d[\d.eE+]*/) || ['\u2014'])[0]) || '\u2014') : 'off';
        setPill(el.fbPScript, running);
        setPill(el.fbPExport, CONFIG.autoExport);
        setPill(el.fbPStrange, CONFIG.smartStrangeness);
        setPill(el.fbPElem, CONFIG.collapseOnElement);
    }

    // ---- Boot -----------------------------------------------------------------
    function boot() {
        if (!exists('makeAllFooter')) { setTimeout(boot, 500); return; } // wait for game UI
        suppressExportDownloads();
        buildHud();
        // expose manual controls for the console
        window.FundamentalBot = { start, stop, tick, CONFIG, report, cycles: cycleLog, log: eventLog, exportSave: exportSaveFile };
        if (CONFIG.autoStart) start();
        console.log('[Fundamental] Autoplayer loaded. Use the on-screen HUD or window.FundamentalBot.start()/.stop()/.report().');
    }

    boot();
})();
