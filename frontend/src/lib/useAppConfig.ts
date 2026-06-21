import { useQuery } from '@tanstack/react-query'
import { api, Config } from './api'

/**
 * Runtime app config delivered by the backend's `/api/config` endpoint.
 *
 * All deploy-specific values (chain_id, rpc URLs, tracker UI base,
 * WalletConnect projectId, public site URL, Telegram bot id) come from
 * here — NOT from VITE_* build-time vars — so a forker can re-point the
 * whole frontend by editing one `.env` on the backend, without rebuilding
 * the SPA.
 *
 * Cached forever (`staleTime: Infinity`): the values change only on a
 * backend redeploy, so any tab opened in a session uses one config.
 */
export function useAppConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<Config>('/config'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
}

/** Pre-computed helpers ready to consume in JSX without manual null checks. */
export function useTrackerLinks(cfg: Config | undefined) {
  const base = (cfg?.tracker_ui_url || '').replace(/\/+$/, '')
  return {
    enabled: !!base,
    address: (addr: string) => (base ? `${base}/address/${addr}` : undefined),
    tx: (hash: string) => (base ? `${base}/tx/${hash}` : undefined),
  }
}
