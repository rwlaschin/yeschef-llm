// Client Firestore via ESM imports (require() doesn't exist in the browser).
// firebase/app + firebase/firestore are isomorphic, so importing them here is
// safe under SSR too; they're only *used* on the client branch below.
import { initializeApp, getApps, getApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

let clientDb: any = null
let serverDb: any = null

export function getDb() {
  if (process.client) {
    if (!clientDb) {
      const config = useRuntimeConfig()
      const firebaseConfig: any = {
        projectId: config.public.gcpProjectId || 'yeschef-c572a',
      }
      // Include the web API key/authDomain if configured (needed for some setups).
      if (config.public.firebaseApiKey) firebaseConfig.apiKey = config.public.firebaseApiKey
      if (config.public.firebaseAuthDomain) firebaseConfig.authDomain = config.public.firebaseAuthDomain

      const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
      clientDb = getFirestore(app)
    }
    return clientDb
  }

  // Server-side: Firebase Admin SDK (require works in Nitro/node).
  if (!serverDb) {
    const { initializeApp: initAdmin, getApps: getAdminApps } = require('firebase-admin/app')
    const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore')
    if (!getAdminApps().length) {
      initAdmin({ projectId: process.env.GCP_PROJECT_ID })
    }
    serverDb = getAdminFirestore()
  }
  return serverDb
}
