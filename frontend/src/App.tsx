import React, { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { AuthModal } from './components/AuthModal';
import { RoleGate } from './components/RoleGate';

import { Home } from './pages/Home';
import { FindLoads } from './pages/FindLoads';
import { OpenBooks } from './pages/OpenBooks';
import { DriveWithUs } from './pages/DriveWithUs';
import { PostLoad } from './pages/PostLoad';
import { Dashboard } from './pages/Dashboard';
import { Admin } from './pages/Admin';
import { NotFound } from './pages/NotFound';
import { PrivacyPolicy, TermsOfUse } from './pages/Legal';
import { CookieConsent } from './components/CookieConsent';

import { api } from './lib/api';
import { trackPage } from './lib/analytics';
import { applyPageMeta, PAGE_META, pathFor, tabForPath } from './lib/routes';
import { User } from './types/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  const [activeTab, setActiveTabState] = useState(() => tabForPath(window.location.pathname));
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authPending, setAuthPending] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Navigation writes the URL as well as the tab, so Back/Forward and a
  // pasted link both work.
  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    const path = pathFor(tab);
    if (window.location.pathname !== path) {
      window.history.pushState({ tab }, '', path);
    }
  }, []);

  // Strip a trailing slash on a known path. Unknown paths stay put so the
  // 404 view matches the address the visitor actually opened.
  useEffect(() => {
    const tab = tabForPath(window.location.pathname);
    const canonical = tab === 'notfound' ? null : pathFor(tab);
    if (canonical && window.location.pathname !== canonical) {
      window.history.replaceState({ tab }, '', canonical + window.location.search);
    }
  }, []);

  useEffect(() => {
    applyPageMeta(activeTab);
    if (activeTab === 'notfound') return;
    const path = PAGE_META[activeTab]?.path;
    if (path) trackPage(path);
  }, [activeTab]);

  // Browser Back/Forward moves between views.
  useEffect(() => {
    const onPopState = () => setActiveTabState(tabForPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Check auth session on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const data = await api.getMe();
        if (data.user) {
          setCurrentUser(data.user);
        }
      } catch {
        // Token invalid or absent
        setCurrentUser(null);
      } finally {
        setAuthPending(false);
      }
    }
    checkAuth();
  }, []);

  const handleLogout = () => {
    api.logout();
    setCurrentUser(null);
    // Do not leave a signed-out browser parked on the admin console.
    if (activeTab === 'admin') {
      setActiveTab('home');
    }
  };

  const handleSwitchRole = () => {
    api.logout();
    setCurrentUser(null);
    setAuthModalOpen(true);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen flex flex-col bg-[#F0EAD8] text-[#22262A] font-sans antialiased">
        {/* Navigation Bar */}
        <Navbar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          currentUser={currentUser}
          onOpenAuth={() => setAuthModalOpen(true)}
          onLogout={handleLogout}
        />

        {/* Page Content */}
        <main className="flex-1">
          {activeTab === 'home' && (
            <Home
              currentUser={currentUser}
              onOpenAuth={() => setAuthModalOpen(true)}
              setActiveTab={setActiveTab}
            />
          )}
          {activeTab === 'loads' && (
            <RoleGate
              tab="loads"
              currentUser={currentUser}
              authPending={authPending}
              accountLabel="driver"
              blurb="The load board is for motor carriers booking freight."
              onOpenAuth={() => setAuthModalOpen(true)}
              onSwitchRole={handleSwitchRole}
            >
              <FindLoads
                currentUser={currentUser}
                onOpenAuth={() => setAuthModalOpen(true)}
                setActiveTab={setActiveTab}
              />
            </RoleGate>
          )}
          {activeTab === 'books' && <OpenBooks />}
          {activeTab === 'driver' && (
            <DriveWithUs
              onSuccessOnboard={(user) => {
                setCurrentUser(user);
                setActiveTab('loads');
              }}
            />
          )}
          {activeTab === 'shipper' && (
            <RoleGate
              tab="shipper"
              currentUser={currentUser}
              authPending={authPending}
              accountLabel="shipper"
              blurb="Posting loads is for shipper accounts."
              onOpenAuth={() => setAuthModalOpen(true)}
              onSwitchRole={handleSwitchRole}
            >
              <PostLoad
                currentUser={currentUser}
                onOpenAuth={() => setAuthModalOpen(true)}
                setActiveTab={setActiveTab}
              />
            </RoleGate>
          )}
          {activeTab === 'dashboard' && (
            <Dashboard
              currentUser={currentUser}
              onOpenAuth={() => setAuthModalOpen(true)}
              onSwitchRole={handleSwitchRole}
            />
          )}
          {activeTab === 'admin' && (
            <Admin
              currentUser={currentUser}
              onOpenAuth={() => setAuthModalOpen(true)}
              onSwitchRole={handleSwitchRole}
            />
          )}
          {activeTab === 'privacy' && <PrivacyPolicy />}
          {activeTab === 'terms' && <TermsOfUse />}
          {activeTab === 'notfound' && <NotFound setActiveTab={setActiveTab} />}
        </main>

        {/* Footer */}
        <Footer setActiveTab={setActiveTab} currentUser={currentUser} />

        {/* Auth Modal */}
        <AuthModal
          isOpen={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          onSuccess={(user) => setCurrentUser(user)}
        />
      </div>
      <CookieConsent
        onNavigate={setActiveTab}
        onChoose={(value) => {
          if (value === 'analytics') {
            const path = PAGE_META[activeTab]?.path;
            if (path) trackPage(path);
          }
        }}
      />
    </QueryClientProvider>
  );
}
