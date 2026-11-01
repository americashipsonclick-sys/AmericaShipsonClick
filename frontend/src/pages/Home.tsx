import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useRealtimeSettlements } from '../lib/useRealtimeSettlements';
import { pctLabel, settlementPreview, usd } from '../lib/settlementPreview';
import { canSeeTab, followTabLink } from '../lib/routes';
import { User, UserRole } from '../types/api';

interface HomeProps {
  currentUser: User | null;
  onOpenAuth: (role?: UserRole) => void;
  setActiveTab: (tab: string) => void;
}

function formatCompactCount(n: number): string {
  return n.toLocaleString();
}

function formatMiles(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n.toLocaleString();
}

function formatPaid(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return usd(n);
}

export const Home: React.FC<HomeProps> = ({ currentUser, onOpenAuth, setActiveTab }) => {
  // A signed-out visitor lands on the page with sign-in already open for that
  // role, so signing in or registering drops them straight into it.
  const openPage = (e: React.MouseEvent<HTMLAnchorElement>, tab: string, role: UserRole) => {
    followTabLink(e, setActiveTab, tab);
    if (e.defaultPrevented && !currentUser) onOpenAuth(role);
  };

  const { data: totals } = useQuery({
    queryKey: ['settlementTotals'],
    queryFn: () => api.getSettlementTotals(),
    refetchInterval: 10000
  });

  const { data: recentSettlements = [], isFetched: settlementsFetched } = useQuery({
    queryKey: ['settlements'],
    queryFn: () => api.getSettlements(50, 1)
  });

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.getConfig()
  });

  useRealtimeSettlements();

  const topSettlement = recentSettlements[0] ?? null;
  const loadsCount = totals?.count ?? 0;
  const milesCount = totals?.miles ?? 0;
  const netPaidCount = totals?.net ?? 0;

  const sample = settlementPreview(780, 2.15, config);
  const feePctLabel = pctLabel(sample.feePct);
  const brokerPctLabel = pctLabel(sample.brokerPct);

  return (
    <div className="bg-[#F0EAD8] text-[#14171A]">
      <section className="grid grid-cols-1 lg:grid-cols-12 border-b-2 border-[#14171A] relative overflow-hidden isolate">
        <img
          src="/hero-truck.jpg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none select-none absolute -z-10 -right-[20%] top-[18%] w-[150%] lg:right-auto lg:-left-[4%] lg:top-auto lg:bottom-[6%] lg:w-[80%] max-w-none opacity-30 lg:opacity-55 [mask-image:radial-gradient(ellipse_at_center,black_62%,transparent_82%)]"
        />
        <div className="lg:col-span-7 p-8 sm:p-12 flex flex-col justify-between border-b-2 lg:border-b-0 lg:border-r-2 border-[#14171A]">
          <div>
            <h1 className="text-5xl sm:text-6xl xl:text-7xl font-serif font-black uppercase leading-[0.85] tracking-tighter mb-6 text-[#14171A]">
              NO BROKERS.<br />
              NO SECRETS.<br />
              JUST <span className="text-[#0F5132]">FREIGHT.</span>
            </h1>
            <p className="max-w-xl text-lg leading-snug border-l-4 border-[#14171A] pl-4 italic opacity-85 mb-8">
              The first trucking platform with a public settlement ledger. We take {feePctLabel}. Shippers pay less, drivers make more. Everyone sees the math.
            </p>

            <div className="flex flex-col items-start gap-3 mb-10">
              {/* Signed out, both show; signed in, only the role's own page. */}
              <div className="flex flex-wrap gap-3">
                {(!currentUser || canSeeTab('loads', currentUser)) && (
                  <a
                    href="/loads"
                    className="btn primary py-3.5 px-6"
                    onClick={(e) => openPage(e, 'loads', 'driver')}
                  >
                    Find Loads
                  </a>
                )}
                {(!currentUser || canSeeTab('shipper', currentUser)) && (
                  <a
                    href="/post-load"
                    className="btn amber py-3.5 px-6"
                    onClick={(e) => openPage(e, 'shipper', 'shipper')}
                  >
                    Post a Load
                  </a>
                )}
              </div>
              <a
                href="/books"
                className="font-mono text-xs font-bold uppercase tracking-widest text-[#0F5132] underline underline-offset-4"
                onClick={(e) => followTabLink(e, setActiveTab, 'books')}
              >
                Read the open books
              </a>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-4 border-2 border-[#14171A] p-4 sm:p-5 bg-white/60 shadow-[4px_4px_0px_#14171A] mb-8">
            <div className="flex flex-col">
              <span className="text-[10px] font-mono font-bold uppercase text-[#8C2F1B]">Loads Settled</span>
              <span className="text-2xl sm:text-3xl font-mono font-black tracking-tighter">
                {formatCompactCount(loadsCount)}
              </span>
            </div>
            <div className="flex flex-col border-x-2 border-[#14171A] px-2 sm:px-4">
              <span className="text-[10px] font-mono font-bold uppercase text-[#8C2F1B]">Miles Hauled</span>
              <span className="text-2xl sm:text-3xl font-mono font-black tracking-tighter">
                {formatMiles(milesCount)}
              </span>
            </div>
            <div className="flex flex-col pl-1 sm:pl-2">
              <span className="text-[10px] font-mono font-bold uppercase text-[#8C2F1B]">Paid To Carriers</span>
              <span className="text-2xl sm:text-3xl font-mono font-black tracking-tighter text-[#0F5132]">
                {formatPaid(netPaidCount)}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-[#14171A]">
              Market Fee Comparison
            </h3>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1 bg-[#8C2F1B] text-[#F0EAD8] p-3.5 relative border-2 border-[#14171A]">
                <div className="text-[10px] font-mono font-bold uppercase opacity-80">Traditional Broker</div>
                <div className="text-2xl font-mono font-bold">{brokerPctLabel}</div>
                <div className="absolute top-2 right-2 transform rotate-12 border border-[#F0EAD8] px-1 text-[8px] opacity-80 font-mono font-bold uppercase">
                  HIDDEN
                </div>
              </div>
              <div className="flex-1 bg-[#0F5132] text-[#F0EAD8] p-3.5 border-2 border-[#14171A]">
                <div className="text-[10px] font-mono font-bold uppercase opacity-80">Our Platform</div>
                <div className="text-2xl font-mono font-bold">{feePctLabel} FLAT</div>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 p-8 sm:p-12 bg-[#E8E2CF]/50 flex flex-col items-center justify-center relative overflow-hidden">
          <div
            className="absolute inset-0 opacity-10 pointer-events-none mix-blend-multiply"
            style={{
              backgroundImage: 'radial-gradient(#000 0.5px, transparent 0.5px)',
              backgroundSize: '3px 3px'
            }}
          />

          {settlementsFetched && topSettlement ? (
            <div className="w-full max-w-md bg-[#FAFAF7] p-6 shadow-[10px_10px_0px_rgba(20,23,26,0.15)] border-2 border-[#14171A] relative rotate-1">
              <div className="punch-holes-left">
                <div className="punch-hole" />
                <div className="punch-hole" />
                <div className="punch-hole" />
                <div className="punch-hole" />
                <div className="punch-hole" />
              </div>

              <div className="flex justify-between items-start border-b-2 border-[#14171A] pb-4 mb-4">
                <div>
                  <div className="text-[10px] font-mono font-bold leading-none uppercase text-[#5B6168]">
                    MANIFEST #{topSettlement.id}
                  </div>
                  <div className="text-xl font-serif font-black uppercase tracking-tight text-[#14171A]">
                    Settlement Detail
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-mono uppercase font-bold text-[#5B6168]">Status</div>
                  <div className="text-[10px] font-mono text-[#0F5132] font-bold">LIVE SETTLED</div>
                </div>
              </div>

              <div className="space-y-2.5 font-mono text-xs">
                <div className="flex justify-between border-b border-dashed border-[#14171A]/20 py-1">
                  <span>ROUTE:</span>
                  <span className="font-bold text-[#14171A]">
                    {topSettlement.origin_city}, {topSettlement.origin_state} &rarr; {topSettlement.dest_city}, {topSettlement.dest_state}
                  </span>
                </div>
                <div className="flex justify-between border-b border-dashed border-[#14171A]/20 py-1">
                  <span>MILES:</span>
                  <span>{Number(topSettlement.miles).toLocaleString()}</span>
                </div>
                <div className="flex justify-between border-b border-dashed border-[#14171A]/20 py-1">
                  <span>GROSS RATE:</span>
                  <span className="font-bold">{usd(Number(topSettlement.gross_amount || 0))}</span>
                </div>
                <div className="flex justify-between border-b border-dashed border-[#14171A]/20 py-1 text-[#8C2F1B]">
                  <span>PLATFORM FEE ({pctLabel(Number(topSettlement.fee_pct_applied) || sample.feePct)}):</span>
                  <span>&minus; {usd(Number(topSettlement.fee_amount || 0))}</span>
                </div>
                <div className="flex justify-between border-b border-dashed border-[#14171A]/20 py-1 text-[#3E444A]">
                  <span>MODELED FUEL:</span>
                  <span>{usd(Number(topSettlement.fuel_cost || 0))}</span>
                </div>

                <div className="pt-4">
                  <div className="flex justify-between items-end">
                    <div className="flex flex-col">
                      <span className="text-[11px] uppercase font-mono font-bold text-[#5B6168]">
                        Final Net Payment
                      </span>
                      <span className="text-3xl font-black font-mono text-[#0F5132]">
                        {usd(Number(topSettlement.net_amount || 0))}
                      </span>
                    </div>
                    <div className="border-4 border-[#0F5132] text-[#0F5132] px-3 py-1 font-mono font-black transform -rotate-12 uppercase tracking-tighter text-xs">
                      PAID VIA ACH
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : settlementsFetched ? (
            <div className="w-full max-w-md bg-[#FAFAF7] p-6 shadow-[10px_10px_0px_rgba(20,23,26,0.15)] border-2 border-[#14171A] relative">
              <div className="text-[10px] font-mono font-bold uppercase text-[#5B6168] mb-2">
                Public Ledger
              </div>
              <div className="text-xl font-serif font-black uppercase tracking-tight text-[#14171A] mb-3">
                No settlements yet
              </div>
              <p className="font-sans text-sm text-[#5B6168]">
                When a haul completes, the breakdown posts here. Until then the books are empty — not invented.
              </p>
            </div>
          ) : null}

          <button
            onClick={() => setActiveTab('books')}
            className="mt-8 bg-[#E3A008] text-[#14171A] border-2 border-[#14171A] px-8 py-3.5 font-mono font-black uppercase tracking-widest text-xs shadow-[6px_6px_0px_#14171A] hover:translate-x-0.5 hover:translate-y-0.5 transition-transform"
          >
            View Full Public Ledger
          </button>
        </div>
      </section>

      <section className="py-16 border-b-2 border-[#14171A] bg-[#FAFAF7]">
        <div className="max-w-295 mx-auto px-6">
          <div className="max-w-2xl mx-auto text-center mb-10">
            <span className="eyebrow block mb-1">The Financial Math</span>
            <h2 className="text-3xl sm:text-4xl mb-3">Same load. Two ways to get paid.</h2>
            <p className="text-[#5B6168] font-sans text-xs sm:text-sm">
              A dry van load: Dallas, TX to Atlanta, GA. 780 miles at $2.15/mile. The {feePctLabel} fee is the platform cut; ledger net also subtracts modeled fuel.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            <div className="receipt">
              <span className="receipt-tag">Traditional Broker</span>
              <div className="receipt-line">
                <span>Shipper pays</span>
                <span>{usd(sample.gross)}</span>
              </div>
              <div className="receipt-line">
                <span>Broker keeps ({brokerPctLabel})</span>
                <span className="text-[#8C2F1B]">&minus;{usd(sample.brokerKeep)}</span>
              </div>
              <div className="receipt-line text-[#5B6168]">
                <span>Hidden margin</span>
                <span>Unlisted</span>
              </div>
              <div className="receipt-line total">
                <span>Carrier receives</span>
                <span>{usd(sample.brokerCarrier)}</span>
              </div>
            </div>

            <div className="receipt us">
              <span className="receipt-tag">America Ships On Click</span>
              <div className="receipt-line">
                <span>Shipper pays</span>
                <span>{usd(sample.gross)}</span>
              </div>
              <div className="receipt-line">
                <span>Platform fee ({feePctLabel})</span>
                <span className="text-[#8C2F1B]">&minus;{usd(sample.fee)}</span>
              </div>
              <div className="receipt-line text-[#5B6168]">
                <span>Modeled fuel (${sample.fuelRate.toFixed(2)}/mi)</span>
                <span>&minus;{usd(sample.fuel)}</span>
              </div>
              <div className="receipt-line font-bold text-[#0F5132]">
                <span>Posted to Open Books</span>
                <span>✓ Public</span>
              </div>
              <div className="receipt-line total text-[#0F5132]">
                <span>Ledger net</span>
                <span className="text-xl font-bold">{usd(sample.net)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 bg-[#F0EAD8]">
        <div className="max-w-295 mx-auto px-6">
          <div className="max-w-2xl mx-auto text-center mb-10">
            <span className="eyebrow block mb-1">How It Works</span>
            <h2 className="text-3xl sm:text-4xl">Three steps. No dispatcher in the middle.</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-6 shadow-[4px_4px_0px_#14171A]">
              <div className="font-mono text-xs text-[#0F5132] font-bold tracking-wider mb-2">
                01 / POST OR FIND
              </div>
              <h3 className="text-xl mb-2">List it or book it</h3>
              <p className="text-[#5B6168] text-sm">
                Shippers post a lane and a rate. Carriers browse the board and book direct — no calls to a broker to "check availability."
              </p>
            </div>
            <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-6 shadow-[4px_4px_0px_#14171A]">
              <div className="font-mono text-xs text-[#0F5132] font-bold tracking-wider mb-2">
                02 / HAUL IT
              </div>
              <h3 className="text-xl mb-2">Run the lane</h3>
              <p className="text-[#5B6168] text-sm">
                Pick up, deliver, upload the POD. Equipment, weight, and pickup window are locked in before you roll.
              </p>
            </div>
            <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-6 shadow-[4px_4px_0px_#14171A]">
              <div className="font-mono text-xs text-[#0F5132] font-bold tracking-wider mb-2">
                03 / GET PAID
              </div>
              <h3 className="text-xl mb-2">Settle same day</h3>
              <p className="text-[#5B6168] text-sm">
                Funds move and the transaction posts to Open Books automatically. No "check's in the mail."
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
