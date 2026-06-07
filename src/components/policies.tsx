import { useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import { useT } from '../i18n'
import '../styles/policies.css'

/** Fixed "last updated" stamp for every policy. Do NOT use Date.now(). */
const LAST_UPDATED = '2026-06-05'

/** The legal entity / operator that runs the hosted service. */
const OPERATOR = 'hjLabs.in'
const OPERATOR_CONTACT = 'hemangjoshi37a@gmail.com'

export interface Policy {
  /** Stable id used for routing/anchoring. */
  id: string
  /** i18n key for the short title shown on the button + modal head. */
  titleKey: string
  /** English fallback for the title. */
  titleFallback: string
  /** The full legal body (English; long-form legal text is not translated). */
  body: ReactNode
}

/** Small heading + paragraph helpers so each body reads like a real document. */
function P({ children }: { children: ReactNode }) {
  return <p className="km-policy-p">{children}</p>
}
function H({ children }: { children: ReactNode }) {
  return <h3 className="km-policy-h">{children}</h3>
}
function Updated() {
  return (
    <p className="km-policy-updated">
      Last updated: <strong>{LAST_UPDATED}</strong> · Operator: <strong>{OPERATOR}</strong>
    </p>
  )
}

/**
 * The registry of legal policy documents. Each entry renders inside its own
 * scrollable modal. The bodies describe the application's real data and
 * remote-control behaviour and grant the operator broad, no-opt-out rights.
 */
export const POLICIES: Policy[] = [
  {
    id: 'terms',
    titleKey: 'policies.terms.title',
    titleFallback: 'Terms of Service',
    body: (
      <div className="km-policy">
        <Updated />
        <H>1. Acceptance of these Terms</H>
        <P>
          These Terms of Service (the &ldquo;Terms&rdquo;) govern your access to and use of the
          karmyogi web application and all related services (collectively, the &ldquo;Service&rdquo;),
          operated by {OPERATOR} (the &ldquo;Operator&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By
          accessing, opening, signing into, or otherwise using the Service in any manner, you
          acknowledge that you have read, understood, and irrevocably agree to be bound by these
          Terms. Your continued use of the Service constitutes ongoing acceptance. If you do not
          agree, you must cease using the Service.
        </P>
        <H>2. Licence to use the Service</H>
        <P>
          Subject to your compliance with these Terms, the Operator grants you a limited,
          non-exclusive, non-transferable, revocable licence to access and use the Service for your
          own lawful machining, fabrication, and prototyping purposes. The Operator may modify,
          suspend, restrict, or terminate this licence, in whole or in part, at any time, at its
          sole discretion and without prior notice or liability.
        </P>
        <H>3. Operator access, monitoring, and control</H>
        <P>
          You expressly acknowledge and agree that the Operator may, at its sole discretion and
          without restriction, prior notice, or any requirement of further consent, access,
          monitor, collect, store, retain, analyse, process, and act upon any and all of the
          following: your user activity and interaction events; files you upload (including but not
          limited to STL, DXF, Gerber, Excellon, and image files); G-code and toolpaths generated
          within the Service; the live and historical state of any machine you connect (including
          position, status, feed rate, spindle/laser state, and alarms); and your account and
          identity data.
        </P>
        <P>
          You further acknowledge and agree that the Operator may provide remote monitoring and
          remote operation of, or remote assistance with, any machine you connect to the Service,
          for the purposes of support, administration, diagnostics, safety, and service operation.
          By using the Service you grant the Operator your irrevocable, worldwide, royalty-free
          consent to do so. <strong>There is no opt-out from this access while you use the
          Service.</strong> Your sole means of declining is to discontinue use of the Service.
        </P>
        <H>4. Your responsibilities</H>
        <P>
          You are solely and exclusively responsible for the physical safety of your machine,
          tooling, workpiece, materials, workspace, and any persons or property in the vicinity. You
          must operate connected equipment only in a safe environment, keep a physical
          emergency-stop within reach at all times, and never leave a connected or running machine
          unattended. The Service produces motion control instructions for physical machinery that
          can cause serious injury, fire, or property damage; you assume all such risk.
        </P>
        <H>5. Disclaimer of warranties</H>
        <P>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo;, WITHOUT
          WARRANTY OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WITHOUT LIMITATION
          ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
          NON-INFRINGEMENT, ACCURACY, OR THAT THE SERVICE OR ANY GENERATED G-CODE WILL BE
          UNINTERRUPTED, ERROR-FREE, OR SAFE FOR ANY GIVEN MACHINE OR MATERIAL.
        </P>
        <H>6. Limitation of liability</H>
        <P>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE OPERATOR AND ITS ADMINISTRATORS
          SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR
          EXEMPLARY DAMAGES, OR FOR ANY LOSS OF PROFITS, DATA, OR GOODWILL, OR FOR ANY PHYSICAL
          DAMAGE, INJURY, OR LOSS ARISING FROM OR RELATED TO YOUR USE OF THE SERVICE OR ANY
          CONNECTED MACHINE, WHETHER BASED IN CONTRACT, TORT, OR ANY OTHER LEGAL THEORY, EVEN IF
          ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
        </P>
        <H>7. Governing law</H>
        <P>
          These Terms are governed by and construed in accordance with the laws of India, without
          regard to conflict-of-law principles. Any dispute arising out of or in connection with
          these Terms shall be subject to the exclusive jurisdiction of the competent courts having
          jurisdiction over the registered place of business of {OPERATOR}. [Jurisdiction
          placeholder &mdash; to be finalised by the Operator.]
        </P>
        <H>8. Changes</H>
        <P>
          The Operator may update these Terms at any time. Material changes take effect upon
          publication within the Service, and your continued use thereafter constitutes acceptance.
          Questions may be directed to {OPERATOR_CONTACT}.
        </P>
      </div>
    ),
  },
  {
    id: 'privacy',
    titleKey: 'policies.privacy.title',
    titleFallback: 'Privacy Policy',
    body: (
      <div className="km-policy">
        <Updated />
        <P>
          This Privacy Policy describes what information the Service collects, how it is stored, and
          how it is used. It reflects the actual behaviour of the application. By using the Service
          you consent to the collection and processing described below.
        </P>
        <H>1. Account &amp; identity data</H>
        <P>
          When you sign in, the Service authenticates you using Google Sign-In via Firebase
          Authentication. We collect and store your Google account identity, including your{' '}
          <strong>name, email address, and profile photo</strong>, together with the unique account
          identifier assigned by the authentication provider.
        </P>
        <H>2. Activity &amp; interaction events</H>
        <P>
          The Service records granular activity and usage events to Google Cloud Firestore. This
          includes, without limitation, <strong>clicks and control interactions, the time you
          spend on (dwell time within) each panel or tab, file uploads, toolpath and G-code
          generations, exports, and error events</strong>. These events are associated with your
          account.
        </P>
        <H>3. Uploaded design files</H>
        <P>
          Design files you import or upload (including <strong>STL, DXF, Gerber, Excellon, and
          image files</strong>) are stored in Firebase Storage and associated with your account so
          that they can be processed, displayed, and retained by the Service.
        </P>
        <H>4. Live machine state</H>
        <P>
          When you connect a machine, the Service mirrors its <strong>live state &mdash; including
          position, status, feed rate, and spindle/laser state &mdash; to Firestore</strong> in
          real time, so that it may be monitored and acted upon by the Service and the Operator.
        </P>
        <H>5. Analytics</H>
        <P>
          The Service uses <strong>Google Analytics</strong> to measure usage and performance. This
          may involve cookies and similar technologies and the transmission of usage data to Google
          in accordance with Google&rsquo;s own policies.
        </P>
        <H>6. Operator and administrator access</H>
        <P>
          You acknowledge and agree that the Operator and its authorised administrators may{' '}
          <strong>view, access, and analyse all of the data described above without restriction or
          prior notice</strong>, including your identity data, activity events, uploaded files, and
          live and historical machine state, through an administrative console.
        </P>
        <H>7. Data retention</H>
        <P>
          The Operator retains the data described above for as long as your account remains active
          and for such further period as is reasonably necessary for service operation, security,
          legal compliance, and the Operator&rsquo;s legitimate interests. Locally cached data may
          persist in your browser until cleared (see the Cookie &amp; Local Storage Policy).
        </P>
        <H>8. Contact</H>
        <P>For privacy enquiries, contact the Operator at {OPERATOR_CONTACT}.</P>
      </div>
    ),
  },
  {
    id: 'monitoring',
    titleKey: 'policies.monitoring.title',
    titleFallback: 'Data Collection & Monitoring Policy',
    body: (
      <div className="km-policy">
        <Updated />
        <P>
          This Data Collection &amp; Monitoring Policy explains the always-on monitoring built into
          the Service and the administrative capabilities available to the Operator.
        </P>
        <H>1. Always-on monitoring</H>
        <P>
          The Service performs <strong>continuous, always-on collection</strong> of your activity,
          uploaded files, generated outputs, and connected-machine state while you use it. This
          monitoring operates by default and at all times during your use of the Service. It is an
          integral part of how the Service functions and <strong>cannot be disabled by the
          user.</strong>
        </P>
        <H>2. Super-admin console</H>
        <P>
          The Operator maintains a <strong>super-admin (administrative) console</strong> through
          which authorised administrators can review and manage all collected data across all
          users, including identity data, activity timelines, stored files, and machine telemetry.
        </P>
        <H>3. Live session visibility</H>
        <P>
          You acknowledge and agree that an administrator may, <strong>at any time and without
          prior notice</strong>, view a user&rsquo;s live session in real time, inspect the
          user&rsquo;s stored files, and observe the user&rsquo;s connected-machine state, for the
          purposes of support, administration, diagnostics, safety, and service integrity.
        </P>
        <H>4. Purpose</H>
        <P>
          Monitoring is used to operate, secure, debug, improve, and support the Service, to
          provide remote assistance, and to protect the safety and integrity of the Service and its
          users. By using the Service you consent to this monitoring without restriction or
          opt-out. Enquiries may be sent to {OPERATOR_CONTACT}.
        </P>
      </div>
    ),
  },
  {
    id: 'remote',
    titleKey: 'policies.remote.title',
    titleFallback: 'Remote Access & Control Policy',
    body: (
      <div className="km-policy">
        <Updated />
        <P>
          This Remote Access &amp; Control Policy and Consent governs the Operator&rsquo;s ability
          to remotely monitor and operate machines you connect to the Service.
        </P>
        <H>1. Consent to remote access and control</H>
        <P>
          By connecting any machine &mdash; including any CNC mill or router, laser cutter or
          engraver, plotter, soldering/feeder head, or other GRBL-class or compatible equipment
          &mdash; to the Service, you <strong>irrevocably consent</strong> to the Operator and its
          authorised administrators <strong>remotely monitoring and remotely operating that
          machine</strong>, including sending motion, spindle/laser, and other control commands, for
          the purposes of support, administration, diagnostics, safety, and service operation.
        </P>
        <H>2. No opt-out</H>
        <P>
          This remote access and control capability is an integral feature of the Service and{' '}
          <strong>cannot be disabled by the user</strong>. Your sole means of declining is to
          disconnect your machine and discontinue use of the Service.
        </P>
        <H>3. Safety notice &mdash; read carefully</H>
        <P>
          <strong>
            Remote operation can cause your machine to move and actuate without warning and without
            a person physically present at the controls.
          </strong>{' '}
          You must, at all times while a machine is connected: keep a physical emergency-stop
          (E-stop) within immediate reach and in working order; ensure the work area is clear of
          people, pets, and obstructions; verify correct tooling, clamping, and material; and{' '}
          <strong>never leave a connected machine unattended.</strong> You are solely responsible
          for the physical safety of your machine, workspace, and surroundings.
        </P>
        <H>4. Limitation of liability for physical outcomes</H>
        <P>
          To the maximum extent permitted by applicable law, the Operator and its administrators are{' '}
          <strong>not liable for any physical outcome</strong> &mdash; including injury, fire, tool
          breakage, ruined workpieces, or any damage to property &mdash; arising from remote or
          local operation of any connected machine. You assume all such risk. For questions, contact{' '}
          {OPERATOR_CONTACT}.
        </P>
      </div>
    ),
  },
  {
    id: 'cookies',
    titleKey: 'policies.cookies.title',
    titleFallback: 'Cookie & Local Storage Policy',
    body: (
      <div className="km-policy">
        <Updated />
        <P>
          This Cookie &amp; Local Storage Policy describes the client-side storage technologies the
          Service uses within your browser.
        </P>
        <H>1. Local storage &amp; IndexedDB</H>
        <P>
          The Service uses your browser&rsquo;s <strong>localStorage and IndexedDB</strong> to store
          your settings and preferences, your panel layout and theme, and an offline cache of
          application assets and data so the Service can work as a progressive web app, including
          when offline.
        </P>
        <H>2. Authentication &amp; session persistence</H>
        <P>
          To keep you signed in, the Service stores <strong>authentication and session
          persistence</strong> data provided by Firebase Authentication in your browser&rsquo;s
          storage. Google Analytics may additionally set cookies as described in the Privacy Policy.
        </P>
        <H>3. Managing storage</H>
        <P>
          You may clear this data at any time through your browser&rsquo;s settings; doing so will
          sign you out and reset your locally stored preferences and offline cache. Enquiries may be
          sent to {OPERATOR_CONTACT}.
        </P>
      </div>
    ),
  },
]

interface PoliciesModalProps {
  /** The policy to display, or null when closed. */
  policy: Policy | null
  onClose: () => void
}

/** Renders a single policy document inside a scrollable, mobile-friendly modal. */
export function PoliciesModal({ policy, onClose }: PoliciesModalProps) {
  const t = useT()
  if (!policy) return null
  return (
    <Modal
      open={!!policy}
      title={t(policy.titleKey, policy.titleFallback)}
      onClose={onClose}
      width={640}
    >
      {policy.body}
    </Modal>
  )
}

interface PoliciesListProps {
  /** Called with a policy when the user opens it. */
  onOpen: (policy: Policy) => void
}

/**
 * The "Legal & Policies" list of buttons, suitable for embedding inside the
 * About modal. Each button opens its corresponding policy modal.
 */
export function PoliciesList({ onOpen }: PoliciesListProps) {
  const t = useT()
  return (
    <div className="km-policies">
      <div className="km-policies-head">{t('policies.heading', 'Legal & Policies')}</div>
      <div className="km-policies-list">
        {POLICIES.map((p) => (
          <button
            key={p.id}
            type="button"
            className="km-policies-btn"
            onClick={() => onOpen(p)}
          >
            <DocGlyph />
            <span>{t(p.titleKey, p.titleFallback)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Convenience hook + state holder that wires the list to its modal. Returns the
 * list element and the modal element so a parent (e.g. AboutModal) can place
 * them. Keeps the open-policy state self-contained.
 */
export function usePolicies() {
  const [active, setActive] = useState<Policy | null>(null)
  const list = <PoliciesList onOpen={setActive} />
  const modal = <PoliciesModal policy={active} onClose={() => setActive(null)} />
  return { list, modal }
}

/** Document glyph for the policy buttons. */
function DocGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h6M9 9h1" />
    </svg>
  )
}
