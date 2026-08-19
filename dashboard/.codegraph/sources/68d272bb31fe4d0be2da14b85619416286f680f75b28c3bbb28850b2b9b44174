import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

let firestoreDb: any = null
function getFirestoreDb() {
  if (!firestoreDb) {
    const projectId = process.env.GCP_PROJECT_ID
    if (!getApps().length) initializeApp({ projectId })
    firestoreDb = getFirestore()
  }
  return firestoreDb
}

// List root collections via the Admin SDK (the client SDK can't enumerate them —
// that's why the UI used to make you type). Mirrors /api/store/mongo-collections.
export default defineEventHandler(async () => {
  try {
    const db = getFirestoreDb()
    const cols = await db.listCollections()
    return cols.map((c: any) => c.id).sort()
  } catch (error: any) {
    console.error('Failed to list Firestore collections:', error)
    throw createError({
      statusCode: 500,
      statusMessage: error.message || 'Failed to list Firestore collections',
    })
  }
})
