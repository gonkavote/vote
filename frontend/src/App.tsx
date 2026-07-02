import { useEffect } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { HomePage } from './pages/Home'
import { ProposalDetailPage } from './pages/ProposalDetail'
import { NewProposalPage } from './pages/NewProposal'
import { MePage } from './pages/Me'
import { PrivacyPage, TermsPage } from './pages/Legal'
import { UserProfilePage } from './pages/UserProfile'
import { GovernanceListPage } from './pages/GovernanceList'
import { GovernanceDetailPage } from './pages/GovernanceDetail'

/** Client-side redirect for legacy /tenders/:id links. Server-side 301 in
 * nginx.conf handles crawler/plain HTTP hits. */
function LegacyProposalRedirect() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/proposal/${id ?? ''}`} replace />
}
import { useAppConfig } from './lib/useAppConfig'
import { setRuntimeConfig } from './lib/wc'

/**
 * Pull /api/config once at boot and hand the deploy-specific values
 * (WC projectId, chain_id, site URL) over to lib/wc so subsequent
 * WalletConnect calls have the right values.
 */
function RuntimeConfigBridge() {
  const { data: cfg } = useAppConfig()
  useEffect(() => {
    if (!cfg) return
    setRuntimeConfig({
      wcProjectId: cfg.wc_project_id,
      chainId: cfg.chain_id,
      publicBaseUrl: cfg.public_base_url,
    })
  }, [cfg])
  return null
}

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <RuntimeConfigBridge />
      <Header />
      <main className="flex-1 pt-20">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/proposal/new" element={<NewProposalPage />} />
          <Route path="/proposal/:id" element={<ProposalDetailPage />} />
          {/* Legacy — SPA-level redirect for client-side navs; nginx.conf
              does the 301 for direct hits. */}
          <Route path="/tenders/new" element={<Navigate to="/proposal/new" replace />} />
          <Route path="/tenders/:id" element={<LegacyProposalRedirect />} />
          <Route path="/governance" element={<GovernanceListPage />} />
          <Route path="/governance/:id" element={<GovernanceDetailPage />} />
          <Route path="/me" element={<MePage />} />
          <Route path="/u/:uid" element={<UserProfilePage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}
