import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { AdminDriver, AdminShipper } from '../types/api';

type DirectoryMode = 'drivers' | 'shippers';

function label(value: string): string {
  return value.replace(/_/g, ' ');
}

function when(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(status: string): string {
  if (status === 'verified' || status === 'open' || status === 'delivered') return 'text-[#0F5132]';
  if (status === 'rejected' || status === 'cancelled') return 'text-[#8C2F1B]';
  return 'text-[#5B3D00]';
}

export const AdminDirectory: React.FC<{ mode: DirectoryMode }> = ({ mode }) => {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['adminDirectory'],
    queryFn: () => api.getAdminDirectory()
  });

  const needle = query.trim().toLowerCase();
  const drivers = useMemo(() => {
    const rows = data?.drivers ?? [];
    if (!needle) return rows;
    return rows.filter((driver) =>
      [driver.full_name, driver.email, driver.phone, driver.cdl_number, driver.dot_number, driver.mc_number, driver.home_base_city, driver.home_base_state]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [data?.drivers, needle]);

  const shippers = useMemo(() => {
    const rows = data?.shippers ?? [];
    if (!needle) return rows;
    return rows.filter((shipper) =>
      [shipper.company_name, shipper.email, shipper.billing_email, shipper.phone]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [data?.shippers, needle]);

  const selectedDriver = drivers.find((driver) => driver.id === selectedId) ?? null;
  const selectedShipper = shippers.find((shipper) => shipper.id === selectedId) ?? null;

  const heading = mode === 'drivers' ? 'Drivers' : 'Shippers';
  const blurb = mode === 'drivers'
    ? 'Open a driver to see the CDL, equipment, documents, and payout status.'
    : 'Open a shipper to see the company profile and recent loads.';

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="eyebrow block mb-1">Accounts</span>
          <h3 className="text-xl font-display-title">{heading}</h3>
          <p className="text-sm text-[#5B6168] mt-1">{blurb}</p>
        </div>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedId(null);
          }}
          placeholder={mode === 'drivers' ? 'Search name, email, CDL, DOT, MC' : 'Search company or email'}
          className="p-2 bg-[#FAFAF7] border border-[#E4DCC4] font-mono text-xs w-full sm:w-72"
        />
      </div>

      {error && (
        <div className="p-3 bg-[#8C2F1B]/10 border border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs">
          {error instanceof Error ? error.message : 'Could not load the directory.'}
        </div>
      )}

      {mode === 'drivers' ? (
        <DriverTable
          rows={drivers}
          loading={isLoading}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((current) => current === id ? null : id)}
        />
      ) : (
        <ShipperTable
          rows={shippers}
          loading={isLoading}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((current) => current === id ? null : id)}
        />
      )}

      {mode === 'drivers' && selectedDriver && <DriverDetail driver={selectedDriver} />}
      {mode === 'shippers' && selectedShipper && <ShipperDetail shipper={selectedShipper} />}
    </section>
  );
};

function DriverTable({
  rows,
  loading,
  selectedId,
  onSelect
}: {
  rows: AdminDriver[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="ledger-table-wrap">
      <table className="ledger">
        <thead>
          <tr>
            <th>Name</th>
            <th>Base</th>
            <th>CDL / MC</th>
            <th>Status</th>
            <th>Bookings</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={5} className="text-center py-6 text-[#5B6168]">Loading drivers...</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={5} className="text-center py-6 text-[#5B6168]">No drivers match.</td></tr>
          ) : rows.map((driver) => (
            <tr
              key={driver.id}
              onClick={() => onSelect(driver.id)}
              className={`cursor-pointer ${selectedId === driver.id ? 'bg-[#E3A008]/20' : ''}`}
            >
              <td>
                <div className="font-bold">{driver.full_name}</div>
                <div className="text-[#5B6168]">{driver.email}</div>
              </td>
              <td>{driver.home_base_city}, {driver.home_base_state}</td>
              <td>{driver.cdl_number || '—'}{driver.mc_number ? ` · ${driver.mc_number}` : ''}</td>
              <td className={`uppercase font-bold ${statusClass(driver.verification_status)}`}>{driver.verification_status}</td>
              <td>{driver.active_booking_count} active / {driver.booking_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShipperTable({
  rows,
  loading,
  selectedId,
  onSelect
}: {
  rows: AdminShipper[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="ledger-table-wrap">
      <table className="ledger">
        <thead>
          <tr>
            <th>Company</th>
            <th>Account email</th>
            <th>Billing</th>
            <th>Loads</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={5} className="text-center py-6 text-[#5B6168]">Loading shippers...</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={5} className="text-center py-6 text-[#5B6168]">No shippers match.</td></tr>
          ) : rows.map((shipper) => (
            <tr
              key={shipper.id}
              onClick={() => onSelect(shipper.id)}
              className={`cursor-pointer ${selectedId === shipper.id ? 'bg-[#E3A008]/20' : ''}`}
            >
              <td className="font-bold">{shipper.company_name}</td>
              <td>{shipper.email}</td>
              <td>{shipper.billing_email}</td>
              <td>{shipper.open_load_count} open / {shipper.load_count}</td>
              <td>{when(shipper.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="uppercase font-bold text-[#5B6168] text-[0.68rem]">{label}</div>
      <div className="text-[#14171A]">{value || '—'}</div>
    </div>
  );
}

function DriverDetail({ driver }: { driver: AdminDriver }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (status: 'verified' | 'rejected' | 'pending') =>
      api.verifyDriver(driver.id, status, status === 'rejected' ? reason.trim() || undefined : undefined),
    onSuccess: () => {
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['adminDirectory'] });
    }
  });
  const equipment = Array.isArray(driver.equipment) ? driver.equipment : [];
  const documents = Array.isArray(driver.documents) ? driver.documents : [];
  return (
    <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-5 shadow-[4px_4px_0_#14171A] space-y-4 font-mono text-xs">
      <div className="flex flex-wrap justify-between gap-2">
        <h4 className="text-lg font-display-title">{driver.full_name}</h4>
        <span className="font-mono text-[0.7rem] text-[#5B6168]">{driver.id}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Email" value={driver.email} />
        <Field label="Phone" value={driver.phone} />
        <Field label="Home base" value={`${driver.home_base_city}, ${driver.home_base_state}`} />
        <Field label="Joined" value={when(driver.created_at)} />
        <Field label="CDL" value={driver.cdl_number ? `${driver.cdl_number} · Class ${driver.cdl_class || '—'}` : null} />
        <Field label="DOT" value={driver.dot_number} />
        <Field label="MC" value={driver.mc_number} />
        <Field label="Verification" value={<span className={`uppercase font-bold ${statusClass(driver.verification_status)}`}>{driver.verification_status}</span>} />
        <Field label="Verified at" value={when(driver.verified_at)} />
        <Field label="Insurance expires" value={when(driver.insurance_expires_at)} />
        <Field label="Payout account" value={driver.payout_on_file ? 'On file' : 'Not on file'} />
        <Field label="Same-day funding" value={driver.same_day_funding_opt_in ? 'Opted in' : 'Off'} />
      </div>
      {driver.rejection_reason && (
        <Field label="Rejection reason" value={driver.rejection_reason} />
      )}
      <div className="border-t border-[#E4DCC4] pt-3 space-y-2">
        <div className="uppercase font-bold text-[#5B6168] text-[0.68rem]">Review decision</div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={decide.isPending || driver.verification_status === 'verified'}
            onClick={() => decide.mutate('verified')}
            className="px-3 py-2 bg-[#0F5132] text-white font-bold uppercase border-2 border-[#14171A] disabled:opacity-40"
          >
            Approve
          </button>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Rejection reason (optional)"
            className="p-2 bg-[#FAFAF7] border border-[#E4DCC4] flex-1 min-w-48"
          />
          <button
            type="button"
            disabled={decide.isPending || driver.verification_status === 'rejected'}
            onClick={() => decide.mutate('rejected')}
            className="px-3 py-2 bg-[#8C2F1B] text-white font-bold uppercase border-2 border-[#14171A] disabled:opacity-40"
          >
            Reject
          </button>
          {driver.verification_status !== 'pending' && (
            <button
              type="button"
              disabled={decide.isPending}
              onClick={() => decide.mutate('pending')}
              className="px-3 py-2 bg-[#FAFAF7] font-bold uppercase border-2 border-[#14171A] disabled:opacity-40"
            >
              Reset to pending
            </button>
          )}
        </div>
        {decide.error && (
          <p className="text-[#8C2F1B]">{decide.error instanceof Error ? decide.error.message : 'Could not save the decision.'}</p>
        )}
      </div>
      <div>
        <div className="uppercase font-bold text-[#5B6168] text-[0.68rem] mb-1">Equipment</div>
        {equipment.length === 0 ? (
          <p className="text-[#5B6168]">No equipment recorded.</p>
        ) : (
          <ul className="space-y-1">
            {equipment.map((item, index) => (
              <li key={`${item.equipment_type}-${index}`}>{label(item.equipment_type)} · {item.trailer_length_ft} ft</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="uppercase font-bold text-[#5B6168] text-[0.68rem] mb-1">Documents</div>
        {documents.length === 0 ? (
          <p className="text-[#5B6168]">No documents uploaded.</p>
        ) : (
          <ul className="space-y-1">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap gap-x-3 gap-y-1">
                <span className="uppercase">{label(doc.doc_type)}</span>
                <span className={statusClass(doc.review_status)}>{doc.review_status}</span>
                <span>{when(doc.uploaded_at)}</span>
                {doc.file_url && (
                  doc.file_url.startsWith('/uploads/') ? (
                    <button
                      type="button"
                      className="text-[#0F5132] underline"
                      onClick={() => {
                        api.downloadUpload(doc.file_url, doc.doc_type).catch((err) => window.alert(err.message));
                      }}
                    >
                      Download file
                    </button>
                  ) : (
                    <a href={doc.file_url} className="text-[#0F5132] underline" target="_blank" rel="noreferrer">Open file</a>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ShipperDetail({ shipper }: { shipper: AdminShipper }) {
  const loads = Array.isArray(shipper.recent_loads) ? shipper.recent_loads : [];
  return (
    <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-5 shadow-[4px_4px_0_#14171A] space-y-4 font-mono text-xs">
      <div className="flex flex-wrap justify-between gap-2">
        <h4 className="text-lg font-display-title">{shipper.company_name}</h4>
        <span className="font-mono text-[0.7rem] text-[#5B6168]">{shipper.id}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Account email" value={shipper.email} />
        <Field label="Billing email" value={shipper.billing_email} />
        <Field label="Phone" value={shipper.phone} />
        <Field label="Joined" value={when(shipper.created_at)} />
        <Field label="Loads posted" value={String(shipper.load_count)} />
        <Field label="Open loads" value={String(shipper.open_load_count)} />
      </div>
      <div>
        <div className="uppercase font-bold text-[#5B6168] text-[0.68rem] mb-2">Recent loads</div>
        {loads.length === 0 ? (
          <p className="text-[#5B6168]">No loads posted yet.</p>
        ) : (
          <ul className="space-y-2">
            {loads.map((load) => (
              <li key={load.id} className="border-t border-dashed border-[#E4DCC4] pt-2">
                <div className="font-bold text-[#14171A]">
                  {load.id} · {load.origin_city}, {load.origin_state} → {load.dest_city}, {load.dest_state}
                </div>
                <div>
                  <span className={`uppercase font-bold ${statusClass(load.status)}`}>{load.status}</span>
                  {' · '}
                  {label(load.equipment_type)}
                  {' · '}
                  {Number(load.miles).toLocaleString()} mi · ${Number(load.rate_per_mile).toFixed(2)}/mi
                  {' · pickup '}
                  {load.pickup_date}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
