// Stub: auth is ADC-based (see ../auth.get.ts) — no browser sign-in flow exists anymore.
export default defineEventHandler((event) => sendRedirect(event, '/servers', 302))
