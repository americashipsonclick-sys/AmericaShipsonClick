import React from 'react';

const UPDATED = 'November 7, 2026';

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-[#14171A]/15 py-6">
      <h2 className="mb-3 text-xl">{heading}</h2>
      <div className="max-w-2xl space-y-3 text-[0.98rem] leading-relaxed">{children}</div>
    </section>
  );
}

function Doc({ title, kicker, children }: { title: string; kicker: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <p className="eyebrow">{kicker}</p>
      <h1 className="mt-2 text-4xl sm:text-5xl tracking-tighter">{title}</h1>
      <p className="mt-3 font-mono text-xs text-[#5B6168]">Updated {UPDATED}</p>
      {children}
    </article>
  );
}

export const PrivacyPolicy: React.FC = () => (
  <Doc title="Privacy policy" kicker="America Ships On Click">
    <Section heading="What this covers">
      <p>
        This policy describes the freight load board and public settlement ledger at America Ships On Click.
        It matches what the software actually stores.
      </p>
    </Section>
    <Section heading="Account and onboarding">
      <p>
        Creating an account stores an email, a hashed password, a role (carrier or shipper), and an optional phone number.
        Carrier profiles store a name, home base, and equipment. Shipper profiles store a company name and billing email.
        Onboarding can include uploads of a CDL, operating authority, and a certificate of insurance. Those files are stored
        as downloads, not rendered as live pages.
      </p>
    </Section>
    <Section heading="Bank details">
      <p>
        Routing and account numbers are turned into an irreversible token before they are saved. The full numbers are not
        written to the database and are not sent to the browser again. The last four digits may be shown back to that carrier.
      </p>
    </Section>
    <Section heading="Public on purpose">
      <p>
        The load board and the settlement ledger are public. A settled load can show the lane, miles, rate,
        and carrier net. Shipper billing email and carrier payment details are not part of that public view.
      </p>
    </Section>
    <Section heading="Sign-in and this browser">
      <p>
        A successful sign-in stores a token in local storage on this device. Signing out removes it. We do not set advertising cookies.
        Network addresses are used to slow repeated sign-in failures and form spam. Those counters expire.
      </p>
    </Section>
    <Section heading="Optional analytics">
      <p>
        Until you choose “Allow analytics,” we do not record page counts. If you allow them, the only field sent is the page path
        (for example, /loads). It is not tied to your account in that record. “Essential only” leaves the choice stored on this
        device and sends nothing.
      </p>
    </Section>
    <Section heading="What we do not do">
      <p>
        We do not sell personal information. API secrets and payment secrets stay on the server. The application is not granted
        the ability to delete ledger rows, so this site does not offer an in-app “delete my account” button. Settlement records
        stay as part of the public books. Questions about an account go to the operator who runs this deployment.
      </p>
    </Section>
  </Doc>
);

export const TermsOfUse: React.FC = () => (
  <Doc title="Terms of use" kicker="America Ships On Click">
    <Section heading="The service">
      <p>
        America Ships On Click is a load board and a public settlement ledger. Shippers post loads. Carriers book them.
        The platform is the software those two parties use. It is not the motor carrier on the load.
      </p>
    </Section>
    <Section heading="Accounts">
      <p>
        You must give information that is yours and accurate. Public signup creates carrier and shipper accounts only.
        Do not share a password. You are responsible for activity under your sign-in.
      </p>
    </Section>
    <Section heading="Fees">
      <p>
        The platform charges no fee on posted or booked loads. Same-day funding, when it is offered, is a separate
        amount shown on the quote. After settlement, the ledger shows the gross and the carrier net for that load.
        Loads settled while a platform fee applied keep that fee on their ledger record.
      </p>
    </Section>
    <Section heading="Loads, bookings, and documents">
      <p>
        Post only freight you can tender. Book only freight you can haul. CDL, authority, and insurance files you upload
        must belong to the carrier on the account. Do not post a lane, rate, or document you know is false.
      </p>
    </Section>
    <Section heading="The public ledger">
      <p>
        Completed settlements are published. Do not use the board to scrape, flood, or probe another carrier’s payment
        account. Login attempts are locked out after repeated failures.
      </p>
    </Section>
    <Section heading="Stopping an account">
      <p>
        The operator may refuse a signup or stop a session that breaks these terms. Because the ledger is append-only,
        closing access does not erase a settlement that was already published.
      </p>
    </Section>
  </Doc>
);
