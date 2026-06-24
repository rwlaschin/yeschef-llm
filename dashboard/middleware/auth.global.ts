// Gate every dashboard route behind login. Client-only enforcement (SSR has no
// session); waits for Firebase auth to resolve, then redirects to /login if there's
// no user. The /ai endpoints are independently protected server-side — this is the UI gate.
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  if (to.path === '/login') return

  const { user, ready } = useAuth()
  if (!ready.value) {
    await new Promise<void>((resolve) => {
      const stop = watch(ready, (r) => { if (r) { stop(); resolve() } }, { immediate: true })
    })
  }
  if (!user.value) return navigateTo('/login')
})
