globalThis.__HEADLESS__ = true;
// Browser-global stubs installed BEFORE the game modules load.
const mk = () => new Proxy(function () {}, {
    get(t, p) {
        if (p === "length") return 0;
        if (p === Symbol.iterator) return function* () {};
        if (p === Symbol.toPrimitive) return () => "";
        return mk();
    },
    set() { return true; }, apply() { return mk(); }, has() { return true; },
});
const dom = mk();
globalThis.document = dom;
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost", href: "http://localhost", reload() {} };
globalThis.navigator = { userAgent: "node", language: "en" };
globalThis.getComputedStyle = () => mk();
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.Audio = function () { return mk(); };
globalThis.Image = function () { return mk(); };
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
