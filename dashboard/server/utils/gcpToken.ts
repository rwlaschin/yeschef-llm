import { GoogleAuth } from 'google-auth-library'

let auth: GoogleAuth | null = null

// Mint a cloud-platform access token from ADC / the service account — the same creds
// the dashboard already uses for Firestore. Used for the Firestore Admin + Rules REST APIs.
export async function gcpAccessToken(): Promise<string> {
  if (!auth) auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient()
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('Could not obtain a GCP access token')
  return token
}
