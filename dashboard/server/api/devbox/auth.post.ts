// Stub: auth is ADC-based (see auth.get.ts) — there is no interactive sign-in to launch.
export default defineEventHandler(() => ({
  ok: true,
  message: 'Authentication is automatic (application-default credentials). Nothing to launch.',
}))
