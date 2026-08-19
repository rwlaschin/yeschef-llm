// Establish + track the Firebase auth session at startup. Real email/password
// login now (see pages/login.vue + middleware/auth.global.ts) — no anonymous
// sign-in. The session's ID token is sent as a Bearer on every /ai call.
//
// Requires: Email/Password sign-in enabled in the Firebase console and the public
// web API key in NUXT_PUBLIC_FIREBASE_API_KEY.
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  if (!config.public.firebaseApiKey) {
    console.warn('[auth] NUXT_PUBLIC_FIREBASE_API_KEY not set — login disabled')
    return
  }
  useAuth().init()
})
