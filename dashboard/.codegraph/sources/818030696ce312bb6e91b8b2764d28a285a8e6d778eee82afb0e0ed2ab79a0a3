import { gcpAccessToken } from '../../utils/gcpToken'

// Live list of deployed composite indexes via the Firestore Admin API.
// `collectionGroups/-` is the wildcard that lists indexes across all collection groups.
export default defineEventHandler(async () => {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) throw createError({ statusCode: 500, statusMessage: 'GCP_PROJECT_ID not set' })
  try {
    const token = await gcpAccessToken()
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/-/indexes`
    const res: any = await $fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    return res.indexes || []
  } catch (err: any) {
    console.error('Failed to list Firestore indexes:', err)
    throw createError({
      statusCode: err?.response?.status || 500,
      statusMessage: err?.data?.error?.message || err.message || 'Failed to list indexes',
    })
  }
})
