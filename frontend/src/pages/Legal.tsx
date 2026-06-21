// Privacy / Terms pages.
//
// This file is intentionally NOT parameterised end-to-end — the rest of the
// app reads its public URL from /api/config (see useAppConfig), but the
// legal text here is per-deployment and per-jurisdiction: the operating
// entity, contact email, effective date and the substantive clauses need
// to be rewritten by whoever is shipping a fork. The constants below
// pre-fill the obvious bits; the body of each page still references
// SERVICE_NAME, SITE_URL and CONTACT_EMAIL throughout.

import { Link } from 'react-router-dom'
import { useAppConfig } from '../lib/useAppConfig'

const SERVICE_NAME = 'Gonka Vote'
const CONTACT_EMAIL = 'gonkavote@gmail.com'
const ENTITY = 'Gonka Vote'
const EFFECTIVE_DATE = 'April 24, 2026'

function useSiteUrl(): string {
  const { data } = useAppConfig()
  return (data?.public_base_url || '').replace(/\/+$/, '')
}

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[760px] mx-auto px-5 md:px-12 py-12">
      <Link to="/" className="text-text-2 text-sm hover:text-accent">← Home</Link>
      <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight mt-6 mb-2">{title}</h1>
      <p className="text-text-2 text-sm mb-8">Effective: {EFFECTIVE_DATE}</p>
      <article className="prose prose-invert prose-sm md:prose-base max-w-none prose-a:text-accent prose-headings:text-text prose-headings:font-bold prose-h2:mt-10 prose-h2:mb-3">
        {children}
      </article>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Privacy Policy
// ---------------------------------------------------------------------------

export function PrivacyPage() {
  const SITE_URL = useSiteUrl()
  return (
    <LegalShell title="Privacy Policy">
      <p>
        This Privacy Policy describes how {ENTITY} ("we", "us", "our")
        collects, uses, and shares information when you use{' '}
        <strong>{SERVICE_NAME}</strong> at <a href={SITE_URL}>{SITE_URL}</a>{' '}
        (the "Service").
      </p>

      <h2>1. Information we collect</h2>

      <h3>1.1 Information you provide</h3>
      <ul>
        <li>
          <strong>Google account profile.</strong> When you sign in with Google,
          we receive your email address, name, profile picture, and Google
          account identifier from Google's OAuth service. We do not receive
          your password.
        </li>
        <li>
          <strong>Wallet address (optional).</strong> If you choose to add a
          Gonka wallet address (<code>gonka1…</code>) to your profile, we store
          it. You can remove it at any time.
        </li>
        <li>
          <strong>Tender content.</strong> Titles, descriptions, and comments
          you publish are stored and displayed publicly together with your name
          and email address.
        </li>
      </ul>

      <h3>1.2 Information from the Gonka blockchain</h3>
      <p>
        The Service indexes public on-chain data from the Gonka blockchain,
        including your wallet's bech32 address (<code>gonka1…</code>),
        transaction hashes, votes you cast on tender contracts, and your public
        GNK balance. This information is already publicly visible on the
        blockchain and is read by us through public RPC endpoints. We do not
        link this on-chain data to your Google account unless you voluntarily
        attach a wallet address to your profile.
      </p>

      <h3>1.3 Technical information</h3>
      <p>
        Like most web services, our servers automatically receive your IP
        address, browser type, and request timestamps in standard server logs.
        These logs are kept for up to 30 days for security and debugging
        purposes.
      </p>

      <h3>1.4 Cookies</h3>
      <p>
        We use a single signed session cookie (<code>gonka_vote_session</code>)
        to keep you logged in after you authenticate with Google. The cookie
        contains your email address and an issued-at timestamp, signed with a
        server secret. We do not use third-party tracking cookies, advertising
        cookies, or analytics that profile you across sites.
      </p>

      <h2>2. How we use information</h2>
      <ul>
        <li>To authenticate you and keep you signed in.</li>
        <li>To display your contributions (tenders, comments, votes) on the Service.</li>
        <li>To compute and display GNK-weighted vote tallies.</li>
        <li>To prevent abuse, detect spam, and operate the Service securely.</li>
      </ul>
      <p>
        We do <strong>not</strong> sell your personal information, and we do
        not use it for advertising.
      </p>

      <h2>3. How we share information</h2>
      <p>We share information only as follows:</p>
      <ul>
        <li>
          <strong>Publicly on the Service.</strong> Your name, email, profile
          picture, optional wallet address, and any tenders or comments you
          post are visible to anyone who visits {SITE_URL}.
        </li>
        <li>
          <strong>Service providers.</strong> We use Google for OAuth
          authentication. Google's handling of your data is governed by
          Google's own Privacy Policy.
        </li>
        <li>
          <strong>Legal compliance.</strong> We may disclose information if
          required by law, court order, or to protect our rights or the safety
          of others.
        </li>
      </ul>
      <p>
        We do not transfer your information to any third party for marketing
        purposes.
      </p>

      <h2>4. Data retention</h2>
      <p>
        We retain account information and content you publish for as long as
        your account exists. If you delete your account (see Section 6 below),
        we delete your profile information within 30 days; published tenders
        and comments may be anonymized rather than deleted to preserve the
        integrity of community discussions.
      </p>
      <p>
        On-chain votes cannot be deleted by us because they are permanently
        stored on the Gonka blockchain.
      </p>

      <h2>5. Security</h2>
      <p>
        We use industry-standard practices to protect data in transit (HTTPS)
        and at rest. No method of transmission or storage is 100% secure;
        please do not share sensitive information through the Service.
      </p>

      <h2>6. Your rights</h2>
      <p>
        You may at any time:
      </p>
      <ul>
        <li>View and edit your profile information at <a href="/me">/me</a>.</li>
        <li>Sign out, which immediately invalidates your session cookie.</li>
        <li>
          Request deletion of your account and associated profile data by
          emailing <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </li>
        <li>
          Request a copy of the personal data we hold about you, by emailing
          the same address.
        </li>
      </ul>
      <p>
        Depending on where you live, you may have additional rights under laws
        such as the EU GDPR or the California CCPA, including the right to
        object to processing or to lodge a complaint with a data protection
        authority.
      </p>

      <h2>7. Children</h2>
      <p>
        The Service is not directed to children under 13, and we do not
        knowingly collect personal information from children under 13.
      </p>

      <h2>8. International transfers</h2>
      <p>
        We may process and store data on servers located in jurisdictions
        other than your own. By using the Service you consent to such
        transfers.
      </p>

      <h2>9. Changes to this Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. The "Effective"
        date at the top of this page indicates when it was last revised.
        Continued use of the Service after changes constitutes acceptance.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions or requests:{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalShell>
  )
}

// ---------------------------------------------------------------------------
// Terms of Service
// ---------------------------------------------------------------------------

export function TermsPage() {
  const SITE_URL = useSiteUrl()
  return (
    <LegalShell title="Terms of Service">
      <p>
        These Terms of Service ("Terms") govern your access to and use of{' '}
        <strong>{SERVICE_NAME}</strong> at <a href={SITE_URL}>{SITE_URL}</a>{' '}
        (the "Service"), operated by {ENTITY} ("we", "us", "our"). By using the
        Service you agree to these Terms.
      </p>

      <h2>1. The Service</h2>
      <p>
        {SERVICE_NAME} is a community-driven portal for proposing and voting on
        ideas ("tenders") related to the Gonka blockchain. Voting takes place
        on-chain via a public smart contract; the Service indexes the results
        and weights them by the voter's current GNK balance. The Service is{' '}
        <strong>indicative only</strong> — it does not modify the Gonka chain,
        does not transfer or hold funds, and does not constitute formal
        governance.
      </p>

      <h2>2. Eligibility & accounts</h2>
      <p>
        You must be at least 13 years old (or the minimum age of digital
        consent in your jurisdiction) to use the Service. To create tenders or
        comments you must sign in with a Google account; you are responsible
        for the security of that account and for all activity under it.
      </p>

      <h2>3. User content</h2>
      <p>
        You retain ownership of content you publish ("User Content"), but you
        grant us a worldwide, non-exclusive, royalty-free licence to host,
        display, and distribute that content as part of the Service.
      </p>
      <p>You agree not to publish User Content that:</p>
      <ul>
        <li>is unlawful, defamatory, harassing, hateful, or threatening;</li>
        <li>infringes intellectual-property or privacy rights of others;</li>
        <li>contains malware, phishing, or spam;</li>
        <li>impersonates any person or misrepresents your affiliation;</li>
        <li>solicits financial contributions in violation of applicable law.</li>
      </ul>
      <p>
        We may remove User Content and suspend accounts that violate these
        Terms, at our discretion and without notice.
      </p>

      <h2>4. On-chain activity & wallets</h2>
      <p>
        Voting is performed by you, from your own wallet, by signing and
        broadcasting transactions to the Gonka blockchain. We do not have
        custody of your private keys, your GNK, or your wallet. Once a
        transaction is on-chain it is permanent and outside our control.
      </p>
      <p>
        The "bid" amount you specify in a vote is a non-binding declaration
        and does not transfer GNK to anyone. You should not interpret tally
        results as a financial offer or commitment.
      </p>

      <h2>5. No financial advice; no token offering</h2>
      <p>
        Nothing on the Service is investment, financial, legal, or tax advice.
        Tenders and discussion threads represent the views of their authors,
        not of {ENTITY}. The Service does not offer or sell securities, tokens,
        or financial products.
      </p>

      <h2>6. Intellectual property</h2>
      <p>
        The Service, including its source code, design, and brand elements,
        is owned by {ENTITY} or its licensors. We grant you a limited,
        non-exclusive, non-transferable licence to use the Service in
        accordance with these Terms.
      </p>

      <h2>7. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES
        OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION
        WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
        NON-INFRINGEMENT, OR THAT THE SERVICE WILL BE UNINTERRUPTED OR ERROR
        FREE. WE DO NOT WARRANT THE ACCURACY OR COMPLETENESS OF ON-CHAIN DATA
        DISPLAYED ON THE SERVICE.
      </p>

      <h2>8. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, {ENTITY.toUpperCase()} AND ITS
        DIRECTORS, EMPLOYEES, AND AGENTS WILL NOT BE LIABLE FOR ANY INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS
        OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR
        ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING
        OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICE.
      </p>

      <h2>9. Indemnification</h2>
      <p>
        You agree to indemnify and hold harmless {ENTITY} from any claim,
        damage, loss, or expense (including reasonable attorneys' fees)
        arising out of your use of the Service, your User Content, or your
        violation of these Terms.
      </p>

      <h2>10. Termination</h2>
      <p>
        We may suspend or terminate your access to the Service at any time,
        with or without cause and with or without notice. You may stop using
        the Service at any time and request account deletion as described in
        the Privacy Policy.
      </p>

      <h2>11. Changes to the Terms</h2>
      <p>
        We may modify these Terms from time to time. The "Effective" date
        indicates the latest revision. Continued use of the Service after
        changes constitutes acceptance of the new Terms.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These Terms are governed by the laws of the jurisdiction in which
        {' '}{ENTITY} is established, without regard to conflict-of-laws
        principles. Disputes shall be resolved in the competent courts of
        that jurisdiction, except where mandatory consumer protection law
        provides otherwise.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions:{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalShell>
  )
}
