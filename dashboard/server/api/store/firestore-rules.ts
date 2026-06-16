import { gcpAccessToken } from '../../utils/gcpToken'

// Live active Firestore security rules via the Firebase Rules API:
//   release `cloud.firestore` → rulesetName → ruleset source files.
export default defineEventHandler(async () => {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) throw createError({ statusCode: 500, statusMessage: 'GCP_PROJECT_ID not set' })
  try {
    const token = await gcpAccessToken()
    const headers = { Authorization: `Bearer ${token}` }
    const release: any = await $fetch(
      `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`,
      { headers }
    )
    const ruleset: any = await $fetch(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`, { headers })
    const files = ruleset?.source?.files || []
    return {
      rulesetName: release.rulesetName,
      source: files.map((f: any) => f.content).join('\n\n'),
    }
  } catch (err: any) {
    console.error('Failed to fetch Firestore rules:', err)
    throw createError({
      statusCode: err?.response?.status || 500,
      statusMessage: err?.data?.error?.message || err.message || 'Failed to fetch rules',
    })
  }
})
