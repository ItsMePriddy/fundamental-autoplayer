// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.6.0
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
        highStageResets: false, // stages 5-6 (merge/nucleation) are major prestige resets with
                                // their own optimal-timing logic. Leave false to let the GAME's
                                // auto-resets handle them. (Stage 4 collapse has dedicated logic.)
        collapseBoost: 4,       // stage 4: collapse when the production boost (#collapseBoostTotal)
                                // reaches this multiple. Higher than vaporization's 2.25 — each
                                // collapse resets more, and later collapses unlock elements/upgrades.
        collapseMaxWaitMs: 90000, // anti-hang: also collapse after this long at a modest boost, so
                                // collapse-gated elements and mass-locked upgrades keep unlocking
                                // (a pure boost gate can stall when a collapse is what's needed).
        collapseMinBoost: 1.3,  // floor for the anti-hang collapse — don't fire a worthless reset.
        verbose: false,         // log every action to console
    };

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
        clickIf('createAllStrangeness');// all strangeness (active stage)
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
        let fire = false;
        if (boost != null && boost >= CONFIG.collapseBoost) fire = true;
        else if (elapsed >= CONFIG.collapseMaxWaitMs / 1000 && (boost == null || boost >= CONFIG.collapseMinBoost)) fire = true;
        if (fire) {
            clickIf('reset0Button');
            collapseLastTs = Date.now();
            pushLog('💥 collapse' + (boost != null ? ' ' + boost.toFixed(2) + '×' : ''));
        }
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
        } else if (CONFIG.highStageResets && resetReady('reset0Button')) {
            // Merge / nucleation: big prestige resets. Off by default — prefer the
            // game's own auto-resets, which time these optimally.
            clickIf('reset0Button');
            log('high-stage reset', s);
        }
    }

    function slowResets() {
        if (CONFIG.doStageReset && resetReady('reset1Button')) {
            clickIf('reset1Button'); log('stage reset');
        }
        if (CONFIG.doEndReset && resetReady('reset2Button')) {
            clickIf('reset2Button'); log('end reset');
        }
    }

    // ---- Main loop ------------------------------------------------------------
    let mainTimer = null;
    let lastSlow = 0;
    let running = false;

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

    // ---- HUD ------------------------------------------------------------------
    let hud = null;
    const el = {}; // cached field elements

    const HUD_CSS = `
    #fbBar{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483600;
        display:flex;align-items:center;gap:11px;padding:9px 18px;border-radius:999px;cursor:pointer;
        font-family:'Inter',system-ui,sans-serif;font-size:13px;color:#e8edf6;user-select:none;
        background:linear-gradient(165deg,rgba(20,18,34,.92),rgba(10,11,20,.95));
        border:1px solid rgba(120,170,255,.25);backdrop-filter:blur(10px);box-shadow:0 6px 22px rgba(0,0,0,.45);}
    #fbBar:hover{border-color:rgba(120,170,255,.55);}
    #fbBar.off{border-color:rgba(248,113,113,.4);}
    #fbBar .d{width:9px;height:9px;border-radius:50%;background:#4ade80;box-shadow:0 0 9px #4ade80;animation:fbP 1.5s ease-in-out infinite;flex:0 0 auto;}
    #fbBar.off .d{background:#f87171;box-shadow:0 0 9px #f87171;animation:none;}
    @keyframes fbP{0%,100%{opacity:1;}50%{opacity:.35;}}
    #fbBar b{font-weight:700;letter-spacing:.2px;}
    #fbBar .s{color:#9fb6d6;font-variant-numeric:tabular-nums;}
    #fbBar .act{font-size:14px;width:18px;text-align:center;color:#cfe0ff;}
    `;

    function buildHud() {
        const style = document.createElement('style');
        style.textContent = HUD_CSS;
        document.head.appendChild(style);
        hud = document.createElement('div');
        hud.id = 'fbBar';
        hud.title = 'Click to start / pause the autoplayer';
        hud.innerHTML = '<span class="d"></span><b>Fundamental Bot</b><span class="s" id="fbStat">\u2014</span><span class="act" id="fbAct">\u23f8</span>';
        document.body.appendChild(hud);
        el.fbStat = $('fbStat');
        el.fbAct = $('fbAct');
        hud.onclick = () => (running ? stop() : start());
        updateHud();
    }

    function updateHud() {
        if (!hud) return;
        hud.className = running ? '' : 'off';
        el.fbAct.textContent = running ? '\u23f8' : '\u25b6';
        const stage = textOf('stageWord');
        el.fbStat.textContent = running
            ? `\u00b7 running${stage ? ' \u00b7 ' + stage : ''}${startTs ? ' \u00b7 ' + fmtDur((Date.now() - startTs) / 1000) : ''}`
            : '\u00b7 paused \u2014 click to start';
    }

    // ---- Boot -----------------------------------------------------------------
    function boot() {
        if (!exists('makeAllFooter')) { setTimeout(boot, 500); return; } // wait for game UI
        buildHud();
        // expose manual controls for the console
        window.FundamentalBot = { start, stop, tick, CONFIG, report, cycles: cycleLog, log: eventLog };
        if (CONFIG.autoStart) start();
        console.log('[Fundamental] Autoplayer loaded. Use the on-screen HUD or window.FundamentalBot.start()/.stop()/.report().');
    }

    boot();
})();
