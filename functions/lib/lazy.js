// Delayed loading: a route/handler's module is imported only the first time it
// actually fires, then cached. Cold starts pay for just the one path that ran,
// not the whole codebase.
//
// Pass a loader thunk (`() => import('./x.js')`) rather than a string path so the
// dynamic import resolves relative to the CALLER, not to this file.
//
// DEV ONLY: the emulator process stays warm across edits, so the cache-forever
// behavior above means every entry-file change needs a full `npm run dev` restart
// to take effect. When NODE_ENV=dev, skip the cache and re-run the loader on
// every call — callers append a `?t=${Date.now()}` cache-bust to their import
// specifier (see functions/index.js) so Node's ESM loader treats it as a distinct
// module and re-reads the file from disk instead of returning the old one.
const isDev = process.env.NODE_ENV === "dev";

export function lazy(loader, method) {
  let mod;
  return async (...args) => {
    if (!mod || isDev) mod = await loader();
    return mod[method](...args);
  };
}
