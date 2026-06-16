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
//
// MUST be recursive: the job's plan/steps/units live in subcollections
// (llmResults/{id}/steps/{stepId}/units/…). Firestore does NOT cascade-delete
// subcollections, so a plain doc.delete() leaves them orphaned — the parent id then
// lingers as a phantom doc (shown italic in the console). recursiveDelete clears the
// whole subtree.
export default defineEventHandler(async (event) => {
  const jobId = getRouterParam(event, 'jobId')
  if (!jobId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing jobId' })
  }

  try {
    const collectionName = process.env.NUXT_PUBLIC_FIRESTORE_COLLECTION_RESULTS || 'llmResults'
    const db = getFirestoreDb()
    // Delete the Job result AND its Menu plan. A menu job saves its inputs to menuPlans/{jobId}
    // (same id); deleting only the result would orphan that doc. menuPlans is absent for non-menu
    // jobs, so the second delete is a harmless no-op — which lets BOTH the menu page and the
    // Requests page reuse this one endpoint and never leave a plan behind.
    await Promise.all([
      db.recursiveDelete(db.collection(collectionName).doc(jobId)),
      db.recursiveDelete(db.collection('menuPlans').doc(jobId)),
    ])
    return { jobId, deleted: true }
  } catch (err: any) {
    console.error('Delete request failed:', err)
    throw createError({ statusCode: 500, statusMessage: `Failed to delete: ${err.message}` })
  }
})
