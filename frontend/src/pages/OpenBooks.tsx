import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useRealtimeSettlements } from '../lib/useRealtimeSettlements';

export const OpenBooks: React.FC = () => {
  // Aggregate stats from DB view
  const { data: totals } = useQuery({
    queryKey: ['settlementTotals'],
    queryFn: () => api.getSettlementTotals(),
    refetchInterval: 10000
  });

  // Public ledger settlements from DB view
  const { data: settlements = [], isLoading } = useQuery({
    queryKey: ['settlements'],
    queryFn: () => api.getSettlements(50, 1)
  });

  // Real-time SSE connection
  const { latestEvent, isConnected } = useRealtimeSettlements();

  const count = totals?.count ?? 0;
  const miles = totals?.miles ?? 0;
  const gross = totals?.gross ?? 0;
  const fee = totals?.fee ?? 0;
  const factor = totals?.factor ?? 0;
  const net = totals?.net ?? 0;

  const avgRatePerMile = miles > 0 ? (gross / miles).toFixed(2) : '0.00';

  // SVG Donut chart logic
  const totalGrossForChart = gross || 1;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;

  const donutSegs = [
    { label: 'Paid to carriers', val: net, color: '#0F5132' },
    // Only settlements from before the fee was removed carry one.
    ...(fee > 0 ? [{ label: 'Past platform fees', val: fee, color: '#E3A008' }] : []),
    { label: 'Same-day funding', val: factor, color: '#8C2F1B' }
  ];

  let cumulativeOffset = 0;

  // Last 10 settlements rate/mile for Bar Chart
  const last10 = settlements.slice(0, 10).reverse();
  const hasPastFees = settlements.some(s => Number(s.fee_amount) > 0);
  const maxRate = Math.max(3.5, ...last10.map(s => Number(s.rate_per_mile)));

  return (
    <div className="py-12 bg-[#F0EAD8] text-[#14171A]">
      <div className="max-w-295 mx-auto px-6">
        <div className="flex flex-wrap items-center gap-4 mb-3">
          <span className="eyebrow">Public Financial Ledger</span>
          <span className="stamp">OPEN BOOKS · LIVE SSE</span>
          {isConnected && (
            <span className="text-xs font-mono text-[#0F5132] font-bold flex items-center gap-1.5 ml-auto">
              <span className="w-2 h-2 rounded-full bg-[#0F5132] animate-ping"></span>
              Live Stream Connected
            </span>
          )}
        </div>

        <h2 className="text-3xl sm:text-4xl mb-2">Every settlement, live, in public.</h2>
        <p className="text-[#5B6168] font-sans text-xs sm:text-sm max-w-3xl mb-8">
          This is the entire ledger of what's settled on the platform — computed directly from database aggregates. Every single load's financial breakdown is published in real time.
        </p>

        {/* Aggregate Stat Strip */}
        <div className="bg-[#14171A] text-[#F0EAD8] py-8 px-6 border-2 border-[#14171A] shadow-[6px_6px_0px_#14171A] my-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
            <div>
              <div className="font-mono text-3xl sm:text-4xl font-black text-[#E3A008]">
                {count.toLocaleString()}
              </div>
              <div className="text-xs uppercase tracking-widest opacity-80 mt-1.5 font-mono font-bold">
                Loads Settled
              </div>
            </div>
            <div className="border-t md:border-t-0 md:border-l-2 border-[#F0EAD8]/20 pt-4 md:pt-0">
              <div className="font-mono text-3xl sm:text-4xl font-black text-[#F0EAD8]">
                ${avgRatePerMile}
              </div>
              <div className="text-xs uppercase tracking-widest opacity-80 mt-1.5 font-mono font-bold">
                Avg Rate / Mile
              </div>
            </div>
            <div className="border-t md:border-t-0 md:border-l-2 border-[#F0EAD8]/20 pt-4 md:pt-0">
              <div className="font-mono text-3xl sm:text-4xl font-black text-[#0F5132] font-bold text-emerald-400">
                {miles.toLocaleString()}
              </div>
              <div className="text-xs uppercase tracking-widest opacity-80 mt-1.5 font-mono font-bold">
                Miles Hauled
              </div>
            </div>
          </div>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 my-10 items-stretch">
          {/* Donut Chart Card */}
          <div className="md:col-span-5 bg-[#FAFAF7] border-2 border-[#14171A] p-6 shadow-[6px_6px_0px_#14171A]">
            <span className="eyebrow block mb-4">Where the gross goes</span>
            <div className="flex flex-col sm:flex-row items-center gap-6">
              <svg viewBox="0 0 180 180" className="w-36 h-36 flex-none">
                <circle cx="90" cy="90" r={radius} fill="none" stroke="#E4DCC4" strokeWidth="24" />
                {donutSegs.map((seg, idx) => {
                  const frac = seg.val / totalGrossForChart;
                  const len = frac * circumference;
                  const strokeDasharray = `${len} ${circumference - len}`;
                  const strokeDashoffset = -cumulativeOffset;
                  cumulativeOffset += len;

                  return (
                    <circle
                      key={idx}
                      cx="90"
                      cy="90"
                      r={radius}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth="24"
                      strokeDasharray={strokeDasharray}
                      strokeDashoffset={strokeDashoffset}
                      transform="rotate(-90 90 90)"
                    />
                  );
                })}
              </svg>

              <div className="space-y-2 text-xs font-mono w-full">
                {donutSegs.map((seg, idx) => {
                  const pct = Math.round((seg.val / totalGrossForChart) * 100);
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="w-3 h-3 border border-[#14171A] flex-none" style={{ backgroundColor: seg.color }}></span>
                      <span className="text-[#5B6168]">{seg.label}:</span>
                      <span className="font-bold ml-auto">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bar Chart Card */}
          <div className="md:col-span-7 bg-[#FAFAF7] border-2 border-[#14171A] p-6 shadow-[6px_6px_0px_#14171A] flex flex-col justify-between">
            <span className="eyebrow block mb-3">Recent Rate Per Mile Trends</span>
            <svg viewBox="0 0 280 120" className="w-full h-36 mt-2">
              {last10.map((s, i) => {
                const bw = 280 / Math.max(last10.length, 1);
                const rateVal = Number(s.rate_per_mile);
                const bh = Math.max(6, (rateVal / maxRate) * 85);
                return (
                  <g key={'bar-' + s.id + '-' + i}>
                    <rect
                      x={i * bw + 4}
                      y={95 - bh}
                      width={bw - 8}
                      height={bh}
                      fill="#0F5132"
                      stroke="#14171A"
                      strokeWidth="1.5"
                    />
                    <text
                      x={i * bw + bw / 2}
                      y="112"
                      fontSize="9"
                      textAnchor="middle"
                      fill="#14171A"
                      fontWeight="bold"
                      fontFamily="var(--font-mono)"
                    >
                      ${rateVal.toFixed(2)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Settlement Ledger Table */}
        <div className="ledger-table-wrap mb-12">
          <table className="ledger">
            <thead>
              <tr>
                <th>Route</th>
                <th>Miles</th>
                <th>Rate / mi</th>
                {hasPastFees && <th>Past Platform Fee</th>}
                <th>Net to Carrier</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={hasPastFees ? 5 : 4} className="text-center py-8 font-mono text-[#5B6168]">
                    Loading public settlement ledger...
                  </td>
                </tr>
              ) : settlements.length === 0 ? (
                <tr>
                  <td colSpan={hasPastFees ? 5 : 4} className="text-center py-8 font-mono text-[#5B6168]">
                    No settlements recorded yet.
                  </td>
                </tr>
              ) : (
                settlements.map((s, idx) => {
                  const isNew = latestEvent?.id === s.id || idx === 0;
                  return (
                    <tr key={s.id} className={isNew ? 'newrow' : ''}>
                      <td className="font-bold">
                        {s.origin_city}, {s.origin_state} &rarr; {s.dest_city}, {s.dest_state}
                      </td>
                      <td>{Number(s.miles).toLocaleString()}</td>
                      <td>${Number(s.rate_per_mile).toFixed(2)}</td>
                      {hasPastFees && <td className="text-[#8C2F1B] font-bold">${Number(s.fee_amount).toFixed(2)}</td>}
                      <td className="text-[#0F5132] font-black text-sm">
                        ${Number(s.net_amount).toFixed(2)}
                        {s.factored && (
                          <span className="text-[0.78rem] bg-[#E3A008] text-[#14171A] border border-[#14171A] px-1.5 py-0.5 ml-2 uppercase font-mono font-black">
                            ⚡ Same-Day
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

