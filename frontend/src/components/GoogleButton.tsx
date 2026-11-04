import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface GoogleIdentityServices {
  initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentityServices } };
  }
}

// The site is in English, so the button is too, whatever the browser's language.
const GIS_SRC = 'https://accounts.google.com/gsi/client?hl=en';

let gisLoad: Promise<GoogleIdentityServices> | null = null;

/** Loads Google's script once, and only when a page actually shows the button. */
function loadGoogleIdentity(): Promise<GoogleIdentityServices> {
  if (!gisLoad) {
    gisLoad = new Promise((resolve, reject) => {
      const existing = window.google?.accounts?.id;
      if (existing) {
        resolve(existing);
        return;
      }
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => {
        const gis = window.google?.accounts?.id;
        if (gis) resolve(gis);
        else reject(new Error('Google sign-in did not load'));
      };
      script.onerror = () => reject(new Error('Google sign-in did not load'));
      document.head.appendChild(script);
    }).catch((err) => {
      gisLoad = null;
      throw err;
    }) as Promise<GoogleIdentityServices>;
  }
  return gisLoad;
}

// Google's renderButton accepts widths from 200 to 400 pixels.
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

interface GoogleButtonProps {
  /** Receives Google's ID token. The server decides what it means. */
  onCredential: (credential: string) => void;
}

/**
 * Google's own "Continue with Google" button, followed by an "or" rule.
 *
 * Renders nothing when the server has no client id or the script is blocked,
 * which leaves the password form as the whole sign-in.
 */
export const GoogleButton: React.FC<GoogleButtonProps> = ({ onCredential }) => {
  const { data: config } = useQuery({
    queryKey: ['google-config'],
    queryFn: () => api.getGoogleConfig(),
    staleTime: Infinity,
    retry: false
  });
  const [failed, setFailed] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;

  const clientId = config?.enabled ? config.client_id : null;

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadGoogleIdentity()
      .then((gis) => {
        if (cancelled || !slot.current) return;
        gis.initialize({
          client_id: clientId,
          callback: (response) => handler.current(response.credential)
        });
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, slot.current.offsetWidth));
        gis.renderButton(slot.current, {
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          logo_alignment: 'center',
          locale: 'en',
          width
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (!clientId || failed) return null;

  return (
    <div className="mb-4">
      <div ref={slot} className="flex justify-center min-h-10" />
      <div className="flex items-center gap-3 mt-4" aria-hidden="true">
        <span className="flex-1 border-t border-[#E4DCC4]" />
        <span className="text-xs font-mono uppercase text-[#5B6168]">or</span>
        <span className="flex-1 border-t border-[#E4DCC4]" />
      </div>
    </div>
  );
};
