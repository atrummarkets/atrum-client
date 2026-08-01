/**
 * Globals that circomlibjs's dependency tree expects to exist, injected into the browser
 * bundle by esbuild's --inject.
 *
 * `buffer`, `events` and `assert` are reachable as bare imports and get aliased to their npm
 * shims, but `Buffer` is also referenced as a FREE GLOBAL inside those packages, which
 * aliasing does not cover. In Node it is always defined; in a browser it is not, and the
 * bundle dies at load with "Buffer is not defined".
 *
 * That distinction is why verify-bundle.mjs deletes globalThis.Buffer before importing --
 * running the check in Node with Buffer present would pass a bundle no browser can load.
 */
import { Buffer } from "buffer";

/**
 * Minimal `process`, for the same reason as Buffer: referenced as a free global inside the
 * dependency tree, undefined in a browser.
 *
 * Deliberately not a polyfill package. Only these fields are actually reached -- `env` for
 * feature flags, `nextTick` for deferral, `browser` for environment sniffing -- and pulling a
 * full process emulation into a bundle the user downloads would be weight for nothing.
 */
const shimProcess = {
  env: {},
  browser: true,
  version: "",
  platform: "browser",
  argv: [],
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};

export { Buffer, shimProcess as process };
