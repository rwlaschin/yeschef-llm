// Client Firestore via ESM imports (require() doesn't exist in the browser).
// firebase/app + firebase/firestore are isomorphic, so importing them here is
// safe under SSR too; they're only *used* on the client branch below.
import { initializeApp, getApps, getApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'

let clientDb: any = null
let serverDb: any = null

// Shared client Firebase app (Firestore + Auth use the same one).
function getClientApp() {
  const config = useRuntimeConfig()
  const firebaseConfig: any = { projectId: config.public.gcpProjectId || 'yeschef-c572a' }
  if (config.public.firebaseApiKey) firebaseConfig.apiKey = config.public.firebaseApiKey
  if (config.public.firebaseAuthDomain) firebaseConfig.authDomain = config.public.firebaseAuthDomain
  return getApps().length ? getApp() : initializeApp(firebaseConfig)
}

// Client Firebase Auth (browser only; null on the server).
export function getClientAuth() {
  if (!process.client) return null
  return getAuth(getClientApp())
}

export function getDb() {
  if (process.client) {
    if (!clientDb) clientDb = getFirestore(getClientApp())
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
