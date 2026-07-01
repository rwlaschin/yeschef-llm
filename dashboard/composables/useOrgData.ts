import { ref, computed } from 'vue'
import { useEnvironment } from './useEnvironment'

/**
 * Shared company + user data for the Request and MenuForm pages.
 * Entities (users) don't carry companyId — membership lives in a separate collection.
 * Users are identified by Firebase uid, not Mongo _id.
 */
export const useOrgData = () => {
  const { env } = useEnvironment()
  const companies = ref<any[]>([])
  const users = ref<any[]>([])

  const companyOptions = computed(() =>
    companies.value.map((c) => ({ value: c._id, label: c.name }))
  )

  const userLabel = (u: any) =>
    `${u.name || u.username || `User ${u.uid?.slice(0, 6)}`}${u.role ? ` · ${u.role}` : ''}`

  const userOptions = computed(() =>
    users.value.map((u) => ({ value: u.uid, label: userLabel(u) }))
  )

  const load = async () => {
    const query = { env: env.value }
    const [c, u] = await Promise.all([
      $fetch<any[]>('/api/db/companies', { query }),
      $fetch<any[]>('/api/db/users', { query }),
    ])
    companies.value = c || []
    users.value = u || []
  }

  return { companies, users, companyOptions, userOptions, userLabel, load }
}
