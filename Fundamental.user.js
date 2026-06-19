// ==UserScript==
// @name         Fundamental Autoplayer
// @namespace    https://github.com/ItsMePriddy/fundamental-autoplayer
// @version      1.0.2
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
        vaporizeBoost: 2,       // stage 2: only vaporize when the production boost would
                                // be at least this multiple (matches the game's own
                                // default auto threshold). Raise it for fewer, bigger
                                // resets and more time to buy structures between them.
        highStageResets: false, // stages 4-6 (collapse/merge/nucleation) are major prestige
                                // resets with their own optimal-timing logic. Leave false to
                                // let the GAME's auto-resets handle them; set true only if you
                                // want the bot to fire them whenever the button looks ready.
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

    // Parse a number out of a stat element's text (handles "2.00", "1.50e3", and
    // thousands separators). Returns null if absent/unparseable.
    const readNum = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const t = (el.textContent || '').trim().replace(/[,\s]/g, '');
        if (!t) return null;
        const n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
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

    // ---- Reset pass -----------------------------------------------------------
    // reset0 = discharge(1) / vaporization(2) / rank(3) / collapse(4) / merge(5) / nucleation(6).
    // Each stage's reset has a very different cost/benefit, so they are handled
    // individually rather than spammed uniformly.
    function fastResets() {
        const s = activeStage();
        if (s === 1) {
            // Discharge: cheap and the regain is always beneficial — the standard
            // early strategy is to discharge constantly. (Don't gate on the label:
            // it can read "Next goal is X Energy" even when a discharge is available.)
            clickIf('reset0Button');
        } else if (s === 2) {
            // Vaporization: a prestige-style reset. Firing it the instant any clouds
            // are available loops forever and starves structure/upgrade buying. Only
            // vaporize when the resulting production boost is worth it. The game shows
            // that exact multiplier in #vaporizationBoostTotal and its own auto uses a
            // default threshold of 2x.
            const boost = readNum('#vaporizationBoostTotal > span');
            if (boost !== null && boost >= CONFIG.vaporizeBoost) {
                clickIf('reset0Button');
                log('vaporize, boost', boost);
            }
        } else if (s === 3) {
            // Rank: hard-gated internally by a mass requirement and capped at maxRank,
            // so this advances milestones rather than looping. Safe to attempt.
            clickIf('reset0Button');
        } else if (CONFIG.highStageResets && resetReady('reset0Button')) {
            // Collapse / merge / nucleation: big prestige resets. Off by default —
            // prefer the game's own auto-resets, which time these optimally.
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
            acceptOfflineDialog();
            applySettings();
            buyEverything();
            fastResets();
            const now = Date.now();
            if (now - lastSlow >= CONFIG.slowResetEveryMs) {
                lastSlow = now;
                slowResets();
            }
        } catch (e) {
            console.error('[Fundamental] tick error', e);
        }
    }

    function start() {
        if (running) return;
        running = true;
        lastSlow = 0;
        tick();
        mainTimer = setInterval(tick, CONFIG.tickMs);
        updatePanel();
        log('started');
    }

    function stop() {
        running = false;
        if (mainTimer) clearInterval(mainTimer);
        mainTimer = null;
        updatePanel();
        log('stopped');
    }

    // ---- Control panel --------------------------------------------------------
    let panelBtn = null;
    function updatePanel() {
        if (!panelBtn) return;
        panelBtn.textContent = running ? '⏸ Auto: ON' : '▶ Auto: OFF';
        panelBtn.style.background = running ? '#1f7a1f' : '#7a1f1f';
    }

    function buildPanel() {
        const wrap = document.createElement('div');
        wrap.style.cssText =
            'position:fixed;bottom:8px;right:8px;z-index:99999;display:flex;gap:6px;' +
            'font-family:sans-serif;font-size:12px;align-items:center;';

        panelBtn = document.createElement('button');
        panelBtn.style.cssText =
            'color:#fff;border:1px solid #fff3;border-radius:6px;padding:6px 10px;' +
            'cursor:pointer;font-weight:bold;';
        panelBtn.onclick = () => (running ? stop() : start());

        wrap.appendChild(panelBtn);
        document.body.appendChild(wrap);
        updatePanel();
    }

    // ---- Boot -----------------------------------------------------------------
    function boot() {
        if (!exists('makeAllFooter')) { setTimeout(boot, 500); return; } // wait for game UI
        buildPanel();
        // expose manual controls for the console
        window.FundamentalBot = { start, stop, tick, CONFIG };
        if (CONFIG.autoStart) start();
        console.log('[Fundamental] Autoplayer loaded. Toggle via the bottom-right button or window.FundamentalBot.start()/.stop().');
    }

    boot();
})();
