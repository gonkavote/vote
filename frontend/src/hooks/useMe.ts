import { useQuery } from '@tanstack/react-query'
import { api, Me } from '../lib/api'

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: () => api.get<Me | null>('/me/optional'),
    staleTime: 60_000,
  })
}
