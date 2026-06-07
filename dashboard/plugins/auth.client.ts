import { initializeApp, getApps, getApp } from 'firebase/app'
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth'

// Auth without login: establish an anonymous Firebase session at startup so the
// client's Firestore reads (history list + per-request onSnapshot) satisfy rules
// that require an authenticated user. No login UI. Firestore automatically re-runs
// active listeners when the auth state resolves, so reads attached before sign-in
// completes will succeed once this lands.
//
// Requires: Anonymous sign-in enabled in Firebase console (Authentication →
// Sign-in method → Anonymous), and the public web API key in NUXT_PUBLIC_FIREBASE_API_KEY.
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const apiKey = config.public.firebaseApiKey as string
  if (!apiKey) {
    console.warn('[auth] NUXT_PUBLIC_FIREBASE_API_KEY not set — anonymous auth skipped')
    return
  }

  const firebaseConfig: any = {
    apiKey,
    projectId: config.public.gcpProjectId || 'yeschef-c572a',
  }
  if (config.public.firebaseAuthDomain) firebaseConfig.authDomain = config.public.firebaseAuthDomain

  const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
  const auth = getAuth(app)

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      signInAnonymously(auth).catch((err) =>
        console.error('[auth] anonymous sign-in failed:', err?.code || err?.message || err)
      )
    }
  })
})
