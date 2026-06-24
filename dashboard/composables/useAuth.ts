import {
  signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider,
  sendPasswordResetEmail, signOut, onAuthStateChanged, type User,
} from 'firebase/auth'
import { getClientAuth } from '~/lib/firebase'

// Real email/password auth for the dashboard (replaces the old anonymous session).
// The token is what protects /ai — every orchestrator call sends it as a Bearer.
export const useAuth = () => {
  const user = useState<User | null>('auth-user', () => null)
  const ready = useState<boolean>('auth-ready', () => false)

  // Called once by plugins/auth.client.ts. Tracks the session; does NOT sign in.
  const init = () => {
    if (!import.meta.client) return
    const auth = getClientAuth()
    if (!auth) { ready.value = true; return }
    onAuthStateChanged(auth, (u) => { user.value = u; ready.value = true })
  }

  const login = async (email: string, password: string) => {
    const auth = getClientAuth()
    if (!auth) throw new Error('Auth unavailable')
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password)
    user.value = cred.user
    return cred.user
  }

  // Google sign-in — same provider/Firebase project as the main app, so a user who signed up there
  // can sign in here with one click. (Popup, matching the app's loginWithGoogle.)
  const loginWithGoogle = async () => {
    const auth = getClientAuth()
    if (!auth) throw new Error('Auth unavailable')
    const cred = await signInWithPopup(auth, new GoogleAuthProvider())
    user.value = cred.user
    return cred.user
  }

  // Send a Firebase password-reset email. Hits the shared Firebase project directly — no app needed.
  const resetPassword = async (email: string) => {
    const auth = getClientAuth()
    if (!auth) throw new Error('Auth unavailable')
    await sendPasswordResetEmail(auth, email.trim())
  }

  const logout = async () => {
    const auth = getClientAuth()
    if (auth) await signOut(auth)
    user.value = null
  }

  // Fresh ID token for Authorization: Bearer on /ai calls. Null if signed out.
  const getToken = async (): Promise<string | null> => {
    const u = getClientAuth()?.currentUser
    return u ? u.getIdToken() : null
  }

  return { user, ready, init, login, loginWithGoogle, resetPassword, logout, getToken }
}
