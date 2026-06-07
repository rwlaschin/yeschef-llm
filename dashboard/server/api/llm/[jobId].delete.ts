import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

let firestoreDb: any = null

function getFirestoreDb() {
  if (!firestoreDb) {
    const projectId = process.env.GCP_PROJECT_ID
    if (!getApps().length) {
      initializeApp({ projectId })
    }
    firestoreDb = getFirestore()
  }
  return firestoreDb
}

// Delete a single history item (its Firestore result doc). Without this the
// client's onSnapshot would just re-add the row after any local removal.
export default defineEventHandler(async (event) => {
  const jobId = getRouterParam(event, 'jobId')
  if (!jobId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing jobId' })
  }

  try {
    const collectionName = process.env.NUXT_PUBLIC_FIRESTORE_COLLECTION_RESULTS || 'llmResults'
    await getFirestoreDb().collection(collectionName).doc(jobId).delete()
    return { jobId, deleted: true }
  } catch (err: any) {
    console.error('Delete request failed:', err)
    throw createError({ statusCode: 500, statusMessage: `Failed to delete: ${err.message}` })
  }
})
