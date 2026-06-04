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

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const { collection, docId } = body

    if (!collection) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Collection name is required',
      })
    }

    const db = getFirestoreDb()

    if (docId) {
      // Get specific document
      const doc = await db.collection(collection).doc(docId).get()
      return {
        exists: doc.exists,
        id: doc.id,
        data: doc.data(),
      }
    } else {
      // List collection (first 50 docs)
      const snapshot = await db.collection(collection).limit(50).get()
      const docs = []
      snapshot.forEach((doc) => {
        docs.push({
          id: doc.id,
          data: doc.data(),
        })
      })
      return docs
    }
  } catch (err) {
    console.error('Firestore query failed:', err)
    throw createError({
      statusCode: 500,
      statusMessage: `Firestore query failed: ${err.message}`,
    })
  }
})
