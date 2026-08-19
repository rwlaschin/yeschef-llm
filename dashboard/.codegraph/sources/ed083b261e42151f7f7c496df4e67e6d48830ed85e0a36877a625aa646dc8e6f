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

// Children of one node in the Firestore tree, paged — powers the drill-down sidebar.
//
//   type:"root"       → list root collections
//   type:"document"   → list a document's subcollections  (path = the doc path)
//   type:"collection" → list a collection's documents     (path = the collection path)
//
// A node that has children gets `hasChildren:true` (→ the UI shows a drill chevron).
// A COLLECTION/SUBCOLLECTION always has ≥1 document (Firestore can't hold an empty one),
// so it's always hasChildren:true and never has fields. Only DOCUMENTS need the per-doc
// work: `hasFields` (does it exist with data → name-click opens a tab) and `hasChildren`
// (does it have subcollections). `listDocuments()` is used (not get()) so that documents
// which hold ONLY subcollections (no fields) still appear.
function paginate<T>(all: T[], offset: number, limit: number) {
  return { children: all.slice(offset, offset + limit), total: all.length, hasMore: offset + limit < all.length }
}
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export default defineEventHandler(async (event) => {
  try {
    const { type = 'root', path = '', offset = 0, limit = 25 } = (await readBody(event)) || {}
    const db = getFirestoreDb()

    if (type === 'root') {
      const cols = await db.listCollections()
      const all = cols.map((c: any) => ({ id: c.id, type: 'collection', path: c.id, hasFields: false, hasChildren: true }))
      return paginate(all.sort(byId), offset, limit)
    }

    if (type === 'document') {
      if (!path) throw createError({ statusCode: 400, statusMessage: 'path is required for a document node' })
      const cols = await db.doc(path).listCollections()
      const all = cols.map((c: any) => ({ id: c.id, type: 'collection', path: `${path}/${c.id}`, hasFields: false, hasChildren: true }))
      return paginate(all.sort(byId), offset, limit)
    }

    // type === 'collection' → its documents (listDocuments includes fieldless/phantom docs).
    if (!path) throw createError({ statusCode: 400, statusMessage: 'path is required for a collection node' })
    const refs = await db.collection(path).listDocuments()
    refs.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const slice = refs.slice(offset, offset + limit)
    const children = await Promise.all(
      slice.map(async (ref: any) => {
        const [snap, subcols] = await Promise.all([ref.get(), ref.listCollections()])
        const data = snap.exists ? snap.data() : null
        return {
          id: ref.id,
          type: 'document',
          path: ref.path,
          hasFields: !!data && Object.keys(data).length > 0,
          hasChildren: subcols.length > 0,
        }
      })
    )
    return { children, total: refs.length, hasMore: offset + limit < refs.length }
  } catch (err: any) {
    console.error('Firestore children query failed:', err)
    throw createError({
      statusCode: err?.statusCode || 500,
      statusMessage: err?.statusMessage || `Firestore children query failed: ${err.message}`,
    })
  }
})
