<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-950 text-gray-100 p-6">
    <div class="w-full max-w-sm bg-gray-900/60 backdrop-blur rounded-2xl p-8 border border-white/10 space-y-6">

      <!-- ── Sign in ── -->
      <template v-if="view === 'login'">
        <div class="space-y-1">
          <h1 class="text-2xl font-bold">YesChef&nbsp;LLM</h1>
          <p class="text-sm text-gray-400">Sign in to the orchestrator dashboard.</p>
        </div>

        <form @submit.prevent="onSubmit" class="space-y-4">
          <input v-model="email" type="email" placeholder="Email" autocomplete="email" required
            class="w-full px-3 py-2.5 rounded-lg bg-gray-800 border border-white/10 outline-none focus:border-primary transition-colors" />
          <div class="space-y-1">
            <div class="flex justify-end">
              <button type="button" @click="goForgot"
                class="text-xs font-medium text-primary hover:text-amber-300 transition-colors">Forgot password?</button>
            </div>
            <input v-model="password" type="password" placeholder="Password" autocomplete="current-password" required
              class="w-full px-3 py-2.5 rounded-lg bg-gray-800 border border-white/10 outline-none focus:border-primary transition-colors" />
          </div>
          <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
          <button type="submit" :disabled="busy"
            class="w-full py-2.5 rounded-lg bg-primary text-gray-900 font-bold hover:brightness-95 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed">
            {{ busy ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>

        <div class="flex items-center gap-3">
          <div class="flex-1 h-px bg-white/10" />
          <span class="text-[11px] uppercase tracking-wider text-gray-500">or</span>
          <div class="flex-1 h-px bg-white/10" />
        </div>

        <!-- Dark Google button — sits BELOW the form and matches the dashboard theme (not the white brand button). -->
        <button type="button" @click="onGoogle" :disabled="busy"
          class="w-full flex items-center justify-center gap-3 py-2.5 rounded-lg bg-gray-800 border border-white/10 text-gray-100 font-semibold text-sm
                 hover:bg-gray-700 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed">
          <GoogleIcon /> Continue with Google
        </button>

        <p v-if="signupUrl" class="text-center text-sm text-gray-400">
          New to YesChef?
          <a :href="signupUrl" class="font-semibold text-primary hover:text-amber-300 transition-colors">Create an account</a>
        </p>
      </template>

      <!-- ── Forgot password ── -->
      <template v-else-if="view === 'forgot'">
        <div class="space-y-1">
          <h1 class="text-2xl font-bold">Reset password</h1>
          <p class="text-sm text-gray-400">We'll email you a reset link.</p>
        </div>
        <form @submit.prevent="onReset" class="space-y-4">
          <input v-model="resetEmail" type="email" placeholder="Email" autocomplete="email" required autofocus
            class="w-full px-3 py-2.5 rounded-lg bg-gray-800 border border-white/10 outline-none focus:border-primary transition-colors" />
          <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
          <button type="submit" :disabled="busy"
            class="w-full py-2.5 rounded-lg bg-primary text-gray-900 font-bold hover:brightness-95 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed">
            {{ busy ? 'Sending…' : 'Send reset link' }}
          </button>
        </form>
        <button type="button" @click="backToLogin" class="w-full text-center text-xs text-gray-500 hover:text-gray-300 transition-colors">Back to sign in</button>
      </template>

      <!-- ── Reset sent ── -->
      <template v-else>
        <div class="space-y-2 text-center">
          <h1 class="text-2xl font-bold">Check your inbox</h1>
          <p class="text-sm text-gray-400">
            If an account exists for <span class="text-gray-200 font-medium">{{ resetEmail }}</span>, a reset link is on its way.
          </p>
        </div>
        <button type="button" @click="backToLogin"
          class="w-full py-2.5 rounded-lg bg-primary text-gray-900 font-bold hover:brightness-95 active:scale-[0.99] transition">Back to sign in</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { h } from 'vue'
definePageMeta({ layout: false })

// Brand-colored Google "G" — same mark as the main app's login (renders fine on the white button).
const GoogleIcon = () => h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', xmlns: 'http://www.w3.org/2000/svg' }, [
  h('path', { d: 'M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z', fill: '#4285F4' }),
  h('path', { d: 'M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z', fill: '#34A853' }),
  h('path', { d: 'M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z', fill: '#FBBC05' }),
  h('path', { d: 'M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z', fill: '#EA4335' }),
])

const { login, loginWithGoogle, resetPassword, user } = useAuth()
const router = useRouter()

// Account creation lives in the main app's /signup (org + plan). Link out only when the app URL is
// configured (NUXT_PUBLIC_APP_URL) — empty in dev → no "Create account" link, no dead end.
const appUrl = (useRuntimeConfig().public.appUrl as string) || ''
const signupUrl = computed(() => (appUrl ? `${appUrl.replace(/\/$/, '')}/signup` : ''))

const view = ref<'login' | 'forgot' | 'forgot-sent'>('login')
const email = ref('')
const password = ref('')
const resetEmail = ref('')
const error = ref('')
const busy = ref(false)

watchEffect(() => { if (user.value) router.replace('/') })

const friendly = (e: any) =>
  e?.code === 'auth/invalid-credential' || e?.code === 'auth/wrong-password' || e?.code === 'auth/user-not-found'
    ? 'Invalid email or password.'
    : e?.code === 'auth/too-many-requests' ? 'Too many attempts — wait a moment and try again.'
    : e?.code === 'auth/popup-closed-by-user' ? 'Sign-in cancelled.'
    : (e?.message || 'Sign in failed')

const goForgot = () => { resetEmail.value = email.value; error.value = ''; view.value = 'forgot' }
const backToLogin = () => { error.value = ''; view.value = 'login' }

const onSubmit = async () => {
  error.value = ''; busy.value = true
  try { await login(email.value, password.value); router.replace('/') }
  catch (e: any) { error.value = friendly(e) }
  finally { busy.value = false }
}

const onGoogle = async () => {
  error.value = ''; busy.value = true
  try { await loginWithGoogle(); router.replace('/') }
  catch (e: any) { error.value = friendly(e) }
  finally { busy.value = false }
}

const onReset = async () => {
  error.value = ''; busy.value = true
  try { await resetPassword(resetEmail.value); view.value = 'forgot-sent' }
  catch (e: any) {
    // Never reveal whether an account exists — treat user-not-found as success.
    if (e?.code === 'auth/user-not-found') view.value = 'forgot-sent'
    else error.value = e?.message || 'Could not send reset email.'
  } finally { busy.value = false }
}
</script>
