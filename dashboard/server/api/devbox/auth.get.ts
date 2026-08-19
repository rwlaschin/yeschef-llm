import { GoogleAuth } from 'google-auth-library'

// Auth check runs in-process against ADC / the service account — the same creds the
// firestore/logging routes already use. No gcloud CLI, no child processes, no browser
// sign-in flow: if ADC can mint a cloud-platform token, the page is authenticated.
let googleAuth: GoogleAuth | null = null

export async function handleAuthGet() {
  try {
    if (!googleAuth) googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
    const client = await googleAuth.getClient()
    const { token } = await client.getAccessToken()
    if (!token) return { ok: false, account: null, error: 'ADC could not mint an access token.' }
    const creds = await googleAuth.getCredentials().catch(() => ({ client_email: undefined }))
    return { ok: true, account: creds.client_email || 'application-default', error: null }
  } catch (e: any) {
    return { ok: false, account: null, error: e?.message || 'GCP credential check failed.' }
  }
}

export default defineEventHandler(() => handleAuthGet())
