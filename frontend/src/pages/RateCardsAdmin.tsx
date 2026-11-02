import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { RateCard } from '../types/api';
import { usd } from '../lib/settlementPreview';

function num(v: string, fallback: number): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export const RateCardsAdmin: React.FC = () => {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: catalog } = useQuery({
    queryKey: ['rates'],
    queryFn: () => api.getRates()
  });

  const { data: quotes = [] } = useQuery({
    queryKey: ['quoteLog'],
    queryFn: () => api.getQuoteLog()
  });

  const saveCard = useMutation({
    mutationFn: ({ key, body }: { key: string; body: Partial<RateCard> }) => api.patchRateCard(key, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rates'] });
      setMessage('Rate card saved.');
      setError(null);
    },
    onError: (err: Error) => setError(err.message)
  });


  const saveAccessorial = useMutation({
    mutationFn: ({ code, amount }: { code: string; amount: number }) => api.patchAccessorial(code, amount),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rates'] });
      setMessage('Accessorial saved.');
      setError(null);
    },
    onError: (err: Error) => setError(err.message)
  });

  return (
    <div className="mt-12 space-y-8">
      <div>
        <span className="eyebrow block mb-1">Rate table</span>
        <h3 className="text-xl font-display-title mb-2">Equipment lookup</h3>
        <p className="text-sm text-[#5B6168] mb-4">
          Bands are editable because region and season move them. Every accepted Post Load quote is logged below.
        </p>
      </div>

      {message && (
        <div className="p-3 bg-[#0F5132]/10 border border-[#0F5132] text-[#0F5132] font-mono text-xs">{message}</div>
      )}
      {error && (
        <div className="p-3 bg-[#8C2F1B]/10 border border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs">{error}</div>
      )}

      <div className="overflow-x-auto border border-[#E4DCC4]">
        <table className="w-full text-left font-mono text-[0.72rem]">
          <thead className="bg-[#14171A] text-[#FAFAF7]">
            <tr>
              <th className="p-2">Equipment</th>
              <th className="p-2">Min/mi</th>
              <th className="p-2">Max/mi</th>
              <th className="p-2">Base/mi</th>
              <th className="p-2">Floor $</th>
              <th className="p-2">Short mi / $</th>
              <th className="p-2">Deadhead %</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {(catalog?.cards ?? []).map(card => (
              <RateCardRow
                key={card.equipment_key}
                card={card}
                saving={saveCard.isPending}
                onSave={(body) => saveCard.mutate({ key: card.equipment_key, body })}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(catalog?.accessorials ?? []).map(a => (
          <AccessorialRow
            key={a.code}
            code={a.code}
            label={a.label}
            amount={a.amount}
            onSave={(amount) => saveAccessorial.mutate({ code: a.code, amount })}
          />
        ))}
      </div>

      <div>
        <h3 className="text-lg font-display-title mb-2">Accepted quotes</h3>
        <div className="overflow-x-auto border border-[#E4DCC4]">
          <table className="w-full text-left font-mono text-[0.72rem]">
            <thead className="bg-[#E4DCC4]">
              <tr>
                <th className="p-2">When</th>
                <th className="p-2">Equipment</th>
                <th className="p-2">Miles</th>
                <th className="p-2">Quoted</th>
                <th className="p-2">Posted $/mi</th>
                <th className="p-2">Load</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map(q => (
                <tr key={q.id} className="border-t border-[#E4DCC4]">
                  <td className="p-2">{new Date(q.created_at).toLocaleString()}</td>
                  <td className="p-2">{q.equipment_label || q.equipment_key}</td>
                  <td className="p-2">{Number(q.miles).toFixed(0)}</td>
                  <td className="p-2">{usd(Number(q.quoted_total))}</td>
                  <td className="p-2">
                    ${Number(q.posted_rate_per_mile).toFixed(2)}
                    {q.overridden ? ' override' : ''}
                  </td>
                  <td className="p-2">{q.load_id || '—'}</td>
                </tr>
              ))}
              {quotes.length === 0 && (
                <tr>
                  <td className="p-3 text-[#5B6168]" colSpan={6}>No accepted quotes yet. Post a load to start the log.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const RateCardRow: React.FC<{
  card: RateCard;
  saving: boolean;
  onSave: (body: Partial<RateCard>) => void;
}> = ({ card, saving, onSave }) => {
  const [min, setMin] = useState(String(card.rate_min_per_mile));
  const [max, setMax] = useState(String(card.rate_max_per_mile));
  const [base, setBase] = useState(String(card.base_rate_per_mile));
  const [floor, setFloor] = useState(String(card.minimum_charge));
  const [shortMiles, setShortMiles] = useState(card.short_haul_under_miles == null ? '' : String(card.short_haul_under_miles));
  const [shortMin, setShortMin] = useState(card.short_haul_minimum_charge == null ? '' : String(card.short_haul_minimum_charge));
  const [deadhead, setDeadhead] = useState(String(card.deadhead_buffer_pct));

  return (
    <tr className="border-t border-[#E4DCC4] bg-[#FAFAF7]">
      <td className="p-2 font-bold">
        {card.label}
        {card.cdl_required ? <span className="block text-[0.65rem] font-normal text-[#5B6168]">CDL</span> : null}
      </td>
      <td className="p-1"><input className="w-16 p-1 bg-white border border-[#E4DCC4]" value={min} onChange={e => setMin(e.target.value)} /></td>
      <td className="p-1"><input className="w-16 p-1 bg-white border border-[#E4DCC4]" value={max} onChange={e => setMax(e.target.value)} /></td>
      <td className="p-1"><input className="w-16 p-1 bg-white border border-[#E4DCC4]" value={base} onChange={e => setBase(e.target.value)} /></td>
      <td className="p-1"><input className="w-16 p-1 bg-white border border-[#E4DCC4]" value={floor} onChange={e => setFloor(e.target.value)} /></td>
      <td className="p-1">
        <div className="flex gap-1">
          <input className="w-14 p-1 bg-white border border-[#E4DCC4]" placeholder="mi" value={shortMiles} onChange={e => setShortMiles(e.target.value)} />
          <input className="w-14 p-1 bg-white border border-[#E4DCC4]" placeholder="$" value={shortMin} onChange={e => setShortMin(e.target.value)} />
        </div>
      </td>
      <td className="p-1"><input className="w-14 p-1 bg-white border border-[#E4DCC4]" value={deadhead} onChange={e => setDeadhead(e.target.value)} /></td>
      <td className="p-1">
        <button
          type="button"
          disabled={saving}
          className="btn ghost text-[0.65rem] py-1 px-2"
          onClick={() => onSave({
            rate_min_per_mile: num(min, card.rate_min_per_mile),
            rate_max_per_mile: num(max, card.rate_max_per_mile),
            base_rate_per_mile: num(base, card.base_rate_per_mile),
            minimum_charge: num(floor, card.minimum_charge),
            short_haul_under_miles: shortMiles === '' ? null : num(shortMiles, 0),
            short_haul_minimum_charge: shortMin === '' ? null : num(shortMin, 0),
            deadhead_buffer_pct: num(deadhead, card.deadhead_buffer_pct)
          })}
        >
          Save
        </button>
      </td>
    </tr>
  );
};

const AccessorialRow: React.FC<{
  code: string;
  label: string;
  amount: number;
  onSave: (amount: number) => void;
}> = ({ code, label, amount, onSave }) => {
  const [value, setValue] = useState(String(amount));
  return (
    <div className="bg-[#FAFAF7] border border-[#E4DCC4] p-3">
      <div className="text-xs font-mono font-bold uppercase mb-2">{label}</div>
      <div className="flex gap-2">
        <input
          className="flex-1 p-2 bg-[#F0EAD8] border border-[#E4DCC4] font-mono text-sm"
          value={value}
          onChange={e => setValue(e.target.value)}
        />
        <button type="button" className="btn ghost text-xs" onClick={() => onSave(num(value, amount))}>
          Save
        </button>
      </div>
      <div className="text-[0.65rem] font-mono text-[#5B6168] mt-1">{code}</div>
    </div>
  );
};
