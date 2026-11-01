import React from 'react';
import { canSeeTab, followTabLink } from '../lib/routes';
import { User } from '../types/api';

interface FooterProps {
  setActiveTab: (tab: string) => void;
  currentUser: User | null;
  feePct?: number;
}

export const Footer: React.FC<FooterProps> = ({ setActiveTab, currentUser, feePct = 0.05 }) => {
  return (
    <footer className="bg-[#14171A] text-[#F0EAD8] py-12 text-[0.85rem] border-t-4 border-[#14171A]">
      <div className="max-w-295 mx-auto px-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          <div>
            <h4 className="text-[#E3A008] font-serif font-black text-sm tracking-widest uppercase mb-3">
              America Ships On Click
            </h4>
            <p className="max-w-[32ch] text-[#F0EAD8]/80 text-xs font-sans leading-relaxed">
              A no-broker load board with a public settlement ledger. Direct booking between shippers and motor carriers without hidden broker markups.
            </p>
          </div>
          <div>
            <h4 className="text-[#F0EAD8] font-mono font-bold text-xs tracking-wider uppercase mb-3 border-b border-[#F0EAD8]/20 pb-1">
              Platform Navigation
            </h4>
            <ul className="list-none p-0 m-0 space-y-2 font-mono text-xs">
              {canSeeTab('loads', currentUser) && (
                <li><a href="/loads" onClick={(e) => followTabLink(e, setActiveTab, 'loads')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Find Loads</a></li>
              )}
              <li><a href="/books" onClick={(e) => followTabLink(e, setActiveTab, 'books')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Open Books Ledger</a></li>
              <li><a href="/dashboard" onClick={(e) => followTabLink(e, setActiveTab, 'dashboard')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Dashboard</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-[#F0EAD8] font-mono font-bold text-xs tracking-wider uppercase mb-3 border-b border-[#F0EAD8]/20 pb-1">
              Get Started
            </h4>
            <ul className="list-none p-0 m-0 space-y-2 font-mono text-xs">
              <li><a href="/drive" onClick={(e) => followTabLink(e, setActiveTab, 'driver')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Drive With Us</a></li>
              {canSeeTab('shipper', currentUser) && (
                <li><a href="/post-load" onClick={(e) => followTabLink(e, setActiveTab, 'shipper')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Post a Load</a></li>
              )}
              <li><a href="/privacy" onClick={(e) => followTabLink(e, setActiveTab, 'privacy')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Privacy Policy</a></li>
              <li><a href="/terms" onClick={(e) => followTabLink(e, setActiveTab, 'terms')} className="text-[#C4BEB0] hover:text-[#E3A008] hover:underline">Terms of Use</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-[#F0EAD8] font-mono font-bold text-xs tracking-wider uppercase mb-3 border-b border-[#F0EAD8]/20 pb-1">
              Fee Guarantee
            </h4>
            <ul className="list-none p-0 m-0 space-y-1.5 font-mono text-xs">
              <li className="text-[#E3A008] font-bold">Platform fee: {(feePct * 100).toFixed(0)}% flat</li>
              <li className="text-[#F0EAD8]/80">No hidden broker spread</li>
              <li className="text-[#F0EAD8]/80">Same-day funding optional (+3%)</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-[#F0EAD8]/20 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-[0.78rem] text-[#F0EAD8]/60">
          <div className="text-[#C4BEB0]">
            FULL-STACK API RUNTIME · REAL-TIME OPEN BOOKS LEDGER. Live PostgreSQL data &amp; SSE events.
          </div>
          <div className="stamp border-[#E3A008] text-[#E3A008]">
            VERIFIED NO-BROKER DIRECT
          </div>
        </div>
      </div>
    </footer>
  );
};

