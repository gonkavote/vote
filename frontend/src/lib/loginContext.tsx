// Tiny global "open the sign-in modal from anywhere" context. The modal
// itself lives in components/LoginModal.tsx; this just exposes
// `openLogin(redirectTo?)` and renders the modal once at the app root.

import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { LoginModal } from '../components/LoginModal'

interface LoginCtx {
  openLogin: (redirect?: string) => void
}

const Ctx = createContext<LoginCtx | null>(null)

export function LoginProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [redirect, setRedirect] = useState('/')

  const openLogin = useCallback((to?: string) => {
    setRedirect(
      to ??
        (typeof window !== 'undefined'
          ? window.location.pathname + window.location.search
          : '/'),
    )
    setOpen(true)
  }, [])

  return (
    <Ctx.Provider value={{ openLogin }}>
      {children}
      {open && <LoginModal redirect={redirect} onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  )
}

export function useLogin(): LoginCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLogin must be used inside <LoginProvider>')
  return v
}
