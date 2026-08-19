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
    const { collection, docId, path } = body
    const db = getFirestoreDb()

    // Drill-down: given a DOC path, return its child collections (+ first 50 docs each).
    // This is how subcollections are discovered — per document, not globally.
    if (path) {
      const subcols = await db.doc(path).listCollections()
      const subcollections = []
      for (const c of subcols) {
        const snap = await c.limit(50).get()
        subcollections.push({
          name: c.id,
          docs: snap.docs.map((d: any) => ({ id: d.id, path: d.ref.path, data: d.data() })),
        })
      }
      return { subcollections }
    }

    if (!collection) {
      throw createError({ statusCode: 400, statusMessage: 'collection or path is required' })
    }

    if (docId) {
      const doc = await db.collection(collection).doc(docId).get()
      return { exists: doc.exists, id: doc.id, path: doc.ref.path, data: doc.data() }
    }

    // List a collection (first 50 docs). Use listDocuments(), NOT a .get() query — a query only
    // returns docs that have fields, silently skipping "phantom" docs that exist solely as parents
    // of subcollections (e.g. tools_limits/web_search). We want those too so they show and can be
    // drilled. Each doc carries its full `path` for subcollection drill-down.
    const refs = (await db.collection(collection).listDocuments()).slice(0, 50)
    const docs = await Promise.all(refs.map(async (ref: any) => {
      const doc = await ref.get()
      return { id: ref.id, path: ref.path, data: doc.exists ? doc.data() : {} }
    }))
    return docs
  } catch (err: any) {
    console.error('Firestore query failed:', err)
    throw createError({
      statusCode: err?.statusCode || 500,
      statusMessage: err?.statusMessage || `Firestore query failed: ${err.message}`,
    })
  }
})
