import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { User, UserRole } from '../types/api';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: User) => void;
  /** The account type the visitor came for, e.g. shipper from Post a Load. Presets sign-up and the heading. */
  role?: UserRole;
}

const ROLE_COPY: Partial<Record<UserRole, { label: string; purpose: string }>> = {
  driver: { label: 'Driver', purpose: 'book loads' },
  shipper: { label: 'Shipper', purpose: 'post loads' }
};

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onSuccess, role: presetRole }) => {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('driver');
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && presetRole) setRole(presetRole);
  }, [isOpen, presetRole]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const roleCopy = presetRole ? ROLE_COPY[presetRole] : undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    const displayName = (role === 'shipper' ? companyName : name).trim();
    if (isSignup && displayName.length < 2) {
      setError(role === 'shipper' ? 'Enter the company name.' : 'Enter your full name.');
      return;
    }

    setLoading(true);

    try {
      if (isSignup) {
        const res = await api.signup({
          email: trimmedEmail,
          password,
          role,
          name: displayName,
          company_name: role === 'shipper' ? displayName : companyName,
          website
        });
        onSuccess(res.user);
      } else {
        const res = await api.login(trimmedEmail, password);
        onSuccess(res.user);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = async (demoRole: UserRole) => {
    if (!import.meta.env.DEV) return;
    setError(null);
    setLoading(true);

    const demoEmails: Record<UserRole, string> = {
      driver: 'john.smith@trucking.com',
      shipper: 'logistics@apexlogistics.com',
      admin: 'admin@americashipsonclick.com'
    };

    try {
      const res = await api.login(demoEmails[demoRole], 'password123');
      onSuccess(res.user);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Demo login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#14171A]/70 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-[#FAFAF7] rounded-md max-w-md w-full p-6 shadow-2xl relative border border-[#E4DCC4]">
        <button
          onClick={onClose}
          className="absolute top-3 right-4 text-2xl font-bold bg-transparent border-none cursor-pointer text-[#5B6168] hover:text-[#14171A]"
          aria-label="Close"
        >
          &times;
        </button>

        <span className="eyebrow block mb-1">
          {isSignup ? 'Create Account' : 'Sign In'}
        </span>
        <h3 className="text-xl font-display-title mb-4">
          {roleCopy
            ? (isSignup ? `Register as a ${roleCopy.label}` : `${roleCopy.label} Sign In`)
            : (isSignup ? 'Join America Ships On Click' : 'Welcome Back')}
        </h3>
        {roleCopy && (
          <p className="text-[#5B6168] text-sm -mt-2 mb-4">
            Sign in to {roleCopy.purpose}, or create a {roleCopy.label.toLowerCase()} account.
          </p>
        )}

        {import.meta.env.DEV && (
        <div className="bg-[#F0EAD8] p-3 rounded border border-[#E4DCC4] mb-4">
          <span className="text-xs font-mono font-bold text-[#0F5132] uppercase block mb-2">
            ⚡ Quick Demo Login (One Click):
          </span>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => handleDemoLogin('driver')}
              className="px-2 py-1.5 text-xs font-mono font-bold bg-[#0F5132] text-[#FAFAF7] rounded hover:opacity-90 border-none cursor-pointer"
            >
              Driver
            </button>
            <button
              type="button"
              onClick={() => handleDemoLogin('shipper')}
              className="px-2 py-1.5 text-xs font-mono font-bold bg-[#14171A] text-[#FAFAF7] rounded hover:opacity-90 border-none cursor-pointer"
            >
              Shipper
            </button>
            <button
              type="button"
              onClick={() => handleDemoLogin('admin')}
              className="px-2 py-1.5 text-xs font-mono font-bold bg-[#E3A008] text-[#14171A] rounded hover:opacity-90 border-none cursor-pointer"
            >
              Admin
            </button>
          </div>
        </div>
        )}

        {error && (
          <div role="alert" className="bg-[#8C2F1B]/10 border border-[#8C2F1B] text-[#8C2F1B] p-2.5 rounded text-xs font-mono mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {isSignup && (
            <div>
              <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                Account Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
              >
                <option value="driver">Motor Carrier / Driver</option>
                <option value="shipper">Shipper / Cargo Owner</option>
              </select>
            </div>
          )}

          {isSignup && (
            <div>
              <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                {role === 'shipper' ? 'Company Name' : 'Full Name'}
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={80}
                autoComplete={role === 'shipper' ? 'organization' : 'name'}
                value={role === 'shipper' ? companyName : name}
                onChange={(e) => role === 'shipper' ? setCompanyName(e.target.value) : setName(e.target.value)}
                placeholder={role === 'shipper' ? 'Apex Logistics' : 'John Smith'}
                className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
              Email Address
            </label>
            <input
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
              Password
            </label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
            />
          </div>

          <div className="absolute left-[-9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
            <label htmlFor="signup-website">Website</label>
            <input
              id="signup-website"
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn primary block w-full mt-4"
          >
            {loading ? 'Processing...' : isSignup ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <div className="mt-4 pt-3 border-t border-[#E4DCC4] text-center">
          <button
            type="button"
            onClick={() => { setIsSignup(!isSignup); setError(null); }}
            className="text-xs font-mono text-[#0F5132] hover:underline bg-transparent border-none cursor-pointer"
          >
            {isSignup
              ? 'Already have an account? Sign In'
              : roleCopy ? `New ${roleCopy.label.toLowerCase()}? Create an account` : 'Need an account? Sign Up'}
          </button>
        </div>
      </div>
    </div>
  );
};
