import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export function Footer() {
  const { t } = useTranslation()
  return (
    <footer className="border-t border-border max-w-[1140px] mx-auto w-full px-5 md:px-12 py-8 mt-12 flex flex-col sm:flex-row items-center justify-between gap-3">
      <p className="text-text-2 text-xs">{t('footer.copyright')} · {t('footer.tagline')}</p>
      <div className="flex flex-wrap gap-6 justify-center">
        <Link to="/privacy" className="text-text-2 text-xs hover:text-accent">
          {t('footer.privacy')}
        </Link>
        <Link to="/terms" className="text-text-2 text-xs hover:text-accent">
          {t('footer.terms')}
        </Link>
        <a href="https://gonka.ai" target="_blank" rel="noopener" className="text-text-2 text-xs hover:text-accent">
          {t('footer.site')}
        </a>
        <a href="https://wallet.gonka.vip" target="_blank" rel="noopener" className="text-text-2 text-xs hover:text-accent">
          {t('footer.wallet')}
        </a>
      </div>
    </footer>
  )
}
