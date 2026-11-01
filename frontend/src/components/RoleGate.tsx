import React from 'react';
import { canSeeTab } from '../lib/routes';
import { User } from '../types/api';

interface RoleGateProps {
  tab: string;
  currentUser: User | null;
  /** True until the stored session has been checked, so a signed-in visitor never sees the gate flash. */
  authPending: boolean;
  /** The account type that may open this page, e.g. "driver". */
  accountLabel: string;
  blurb: string;
  onOpenAuth: () => void;
  onSwitchRole: () => void;
  children: React.ReactNode;
}

/**
 * Shows a page only to the roles `TAB_ROLES` allows for its tab.
 *
 * Presentation only, like the /admin gate: the API still enforces who may
 * post or book.
 */
export const RoleGate: React.FC<RoleGateProps> = ({
  tab,
  currentUser,
  authPending,
  accountLabel,
  blurb,
  onOpenAuth,
  onSwitchRole,
  children
}) => {
  if (canSeeTab(tab, currentUser)) return <>{children}</>;
  if (authPending) return null;

  if (!currentUser) {
    return (
      <div className="py-16">
        <div className="max-w-160 mx-auto px-6 text-center">
          <div className="p-8 bg-[#FAFAF7] border-2 border-[#E3A008] rounded shadow-md space-y-4">
            <span className="eyebrow block">Protected Area</span>
            <h2 className="text-2xl font-display-title text-[#14171A]">
              Authentication Required
            </h2>
            <p className="text-[#5B6168] text-sm">
              {blurb} Sign in with a {accountLabel} account to continue.
            </p>
            <button onClick={onOpenAuth} className="btn amber px-8 py-3 font-mono">
              Sign In or Select Demo Account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="py-16">
      <div className="max-w-160 mx-auto px-6 text-center">
        <div className="p-8 bg-[#FAFAF7] border-2 border-[#8C2F1B] rounded shadow-md space-y-4">
          <span className="eyebrow block">Access Denied</span>
          <h2 className="text-2xl font-display-title text-[#14171A] capitalize">
            {accountLabel} Account Required
          </h2>
          <p className="text-[#5B6168] text-sm">
            You are signed in as{' '}
            <b className="font-mono uppercase">{currentUser.role}</b>. {blurb}
          </p>
          <button onClick={onSwitchRole} className="btn amber px-8 py-3 font-mono">
            Switch Account
          </button>
        </div>
      </div>
    </div>
  );
};
