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
    const jobRef = db.collection(collectionName).doc(jobId)
    // Delete the Job result AND its Menu plan. A menu job saves its inputs to
    // companies/{companyId}/menuPlans/{jobId} (path-scoped tenant). companyId rides the
    // llmResults doc, so read it first; the plan delete is skipped for non-menu jobs (no
    // companyId) — lets BOTH the menu page and the Requests page reuse this one endpoint.
    const snap = await jobRef.get()
    const companyId = snap.exists ? snap.data()?.companyId : null
    await Promise.all([
      db.recursiveDelete(jobRef),
      companyId
        ? db.recursiveDelete(db.collection('companies').doc(companyId).collection('menuPlans').doc(jobId))
        : Promise.resolve(),
    ])
    return { jobId, deleted: true }
  } catch (err: any) {
    console.error('Delete request failed:', err)
    throw createError({ statusCode: 500, statusMessage: `Failed to delete: ${err.message}` })
  }
})
