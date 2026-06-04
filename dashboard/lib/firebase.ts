let clientDb: any = null
let serverDb: any = null

export function getDb() {
  if (process.client) {
    // Client-side: Firebase Client SDK
    if (!clientDb) {
      const { initializeApp } = require('firebase/app')
      const { getFirestore } = require('firebase/firestore')

      const config = useRuntimeConfig()
      const firebaseConfig = {
        projectId: config.public.gcpProjectId || 'yeschef-c572a',
      }
      const app = initializeApp(firebaseConfig)
      clientDb = getFirestore(app)
    }
    return clientDb
  } else {
    // Server-side: Firebase Admin SDK
    if (!serverDb) {
      const { initializeApp } = require('firebase-admin/app')
      const { getFirestore } = require('firebase-admin/firestore')
      const { getApps } = require('firebase-admin/app')

      if (!getApps().length) {
        const projectId = process.env.GCP_PROJECT_ID
        initializeApp({ projectId })
      }
      serverDb = getFirestore()
    }
    return serverDb
  }
}
