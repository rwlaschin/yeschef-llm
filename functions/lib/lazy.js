// Delayed loading: a route/handler's module is imported only the first time it
// actually fires, then cached. Cold starts pay for just the one path that ran,
// not the whole codebase.
//
// Pass a loader thunk (`() => import('./x.js')`) rather than a string path so the
// dynamic import resolves relative to the CALLER, not to this file.
export function lazy(loader, method) {
  let mod;
  return async (...args) => {
    if (!mod) mod = await loader();
    return mod[method](...args);
  };
}
