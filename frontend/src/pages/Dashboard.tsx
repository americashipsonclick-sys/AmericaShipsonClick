import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { LoadDetail } from '../components/LoadDetail';
import { BookingWithLoad, Load, User } from '../types/api';
import { usd } from '../lib/settlementPreview';

interface DashboardProps {
  currentUser: User | null;
  onOpenAuth: () => void;
  onSwitchRole: () => void;
  /** Absent in the admin console, which embeds only the ledger view (no trips). */
  onOpenTrip?: (bookingId: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ currentUser, onOpenAuth, onSwitchRole, onOpenTrip = () => undefined }) => {
  const queryClient = useQueryClient();
  const [podBusy, setPodBusy] = useState<Record<string, boolean>>({});
  const [podError, setPodError] = useState<Record<string, string>>({});
  const [openLoad, setOpenLoad] = useState<Load | null>(null);

  const { data: adminLedger = [], isLoading: isLoadingAdmin } = useQuery({
    queryKey: ['adminLedger'],
    queryFn: () => api.getAdminLedger(),
    enabled: !!currentUser && currentUser.role === 'admin'
  });

  const { data: settlements = [], isLoading: isLoadingSettlements } = useQuery({
    queryKey: ['settlements'],
    queryFn: () => api.getSettlements(50, 1),
    enabled: !!currentUser
  });
  // Only settlements from before the fee was removed carry one.
  const adminHasPastFees = adminLedger.some((item: { fee_amount: number }) => Number(item.fee_amount) > 0);
  const driverHasPastFees = settlements.some((s) => Number(s.fee_amount) > 0);

  const { data: bookings = [], isLoading: isLoadingBookings } = useQuery({
    queryKey: ['bookings'],
    queryFn: () => api.getBookings(),
    enabled: !!currentUser && currentUser.role !== 'admin'
  });

  const { data: myLoads = [] } = useQuery({
    queryKey: ['loads', 'mine'],
    queryFn: () => api.getMyLoads(),
    enabled: !!currentUser && currentUser.role === 'shipper'
  });

  const completeBookingMutation = useMutation({
    mutationFn: (bookingId: string) => api.completeBooking(bookingId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlements'] });
      queryClient.invalidateQueries({ queryKey: ['settlementTotals'] });
      queryClient.invalidateQueries({ queryKey: ['adminLedger'] });
      queryClient.invalidateQueries({ queryKey: ['loads'] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
    }
  });

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
              The owner dashboard contains driver and shipper activity, active bookings, and CSV export tools. Please sign in to access your dashboard.
            </p>
            <button
              onClick={onOpenAuth}
              className="btn amber px-8 py-3 font-mono"
            >
              Sign In or Select Demo Account
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleExportCSV = async () => {
    try {
      await api.downloadAdminExport();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'CSV export failed');
    }
  };

  const handlePodUpload = async (bookingId: string, file: File) => {
    setPodBusy((prev) => ({ ...prev, [bookingId]: true }));
    setPodError((prev) => {
      const next = { ...prev };
      delete next[bookingId];
      return next;
    });
    try {
      const uploaded = await api.uploadFile(file);
      await api.uploadPod(bookingId, uploaded.file_url);
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    } catch (err: unknown) {
      setPodError((prev) => ({
        ...prev,
        [bookingId]: err instanceof Error ? err.message : 'POD upload failed'
      }));
    } finally {
      setPodBusy((prev) => ({ ...prev, [bookingId]: false }));
    }
  };

  const activeBookings = bookings.filter((b) => b.status === 'active');
  // A shipper reaches a trip through the load; at most one booking per load is not cancelled.
  const bookingByLoad = new Map(bookings.filter((b) => b.status !== 'cancelled').map((b) => [b.load_id, b]));
  const isDriver = currentUser.role === 'driver';
  const isShipper = currentUser.role === 'shipper';

  return (
    <div className="py-12">
      <div className="max-w-295 mx-auto px-6">
        <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="eyebrow">Owner Dashboard</span>
              <span className="font-mono text-xs bg-[#0F5132] text-[#FAFAF7] px-2 py-0.5 rounded font-bold uppercase">
                {currentUser.role} ROLE
              </span>
            </div>
            <h2 className="text-2xl sm:text-3xl">Settlement &amp; Activity Ledger</h2>
          </div>

          <div className="flex items-center gap-3">
            {currentUser.role === 'admin' && (
              <button onClick={handleExportCSV} className="btn ghost py-2 text-xs">
                Export Ledger CSV
              </button>
            )}
            <button onClick={onSwitchRole} className="btn amber py-2 text-xs">
              Switch Role
            </button>
          </div>
        </div>

        {currentUser.role === 'admin' ? (
          <div className="space-y-6">
            <div className="p-3 bg-[#0F5132]/10 border border-[#0F5132] text-[#0F5132] rounded font-mono text-xs">
              <strong>Admin Mode:</strong> Displaying full financial breakdown including internal driver identities, CDL numbers, and shipper company profiles.
            </div>

            <div className="ledger-table-wrap">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Settlement ID</th>
                    <th>Route</th>
                    <th>Driver Name</th>
                    <th>Shipper Company</th>
                    <th>Gross Rate</th>
                    {adminHasPastFees && <th>Past Fee</th>}
                    <th>Net Amount</th>
                    <th>Settled Date</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoadingAdmin ? (
                    <tr>
                      <td colSpan={adminHasPastFees ? 8 : 7} className="text-center py-6 font-mono text-[#5B6168]">
                        Loading admin ledger...
                      </td>
                    </tr>
                  ) : adminLedger.length === 0 ? (
                    <tr>
                      <td colSpan={adminHasPastFees ? 8 : 7} className="text-center py-6 font-mono text-[#5B6168]">
                        No settlements found.
                      </td>
                    </tr>
                  ) : (
                    adminLedger.map((item: { id: string; origin_city: string; origin_state: string; dest_city: string; dest_state: string; driver_name?: string; shipper_name?: string; gross_amount: number; fee_amount: number; net_amount: number; settled_at: string }) => (
                      <tr key={item.id}>
                        <td className="font-bold text-[#5B6168]">{item.id}</td>
                        <td className="font-bold">
                          {item.origin_city}, {item.origin_state} &rarr; {item.dest_city}, {item.dest_state}
                        </td>
                        <td>{item.driver_name || 'Driver'}</td>
                        <td>{item.shipper_name || 'Shipper'}</td>
                        <td>{usd(Number(item.gross_amount))}</td>
                        {adminHasPastFees && <td className="text-[#5B3D00]">{usd(Number(item.fee_amount))}</td>}
                        <td className="text-[#0F5132] font-bold">{usd(Number(item.net_amount))}</td>
                        <td>{new Date(item.settled_at).toLocaleDateString()}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {isDriver && (
              <ActiveBookingsPanel
                bookings={activeBookings}
                isLoading={isLoadingBookings}
                podBusy={podBusy}
                podError={podError}
                completingId={completeBookingMutation.isPending ? String(completeBookingMutation.variables ?? '') : null}
                completeError={completeBookingMutation.error instanceof Error ? completeBookingMutation.error.message : null}
                onPodFile={(bookingId, file) => handlePodUpload(bookingId, file)}
                onComplete={(bookingId) => completeBookingMutation.mutate(bookingId)}
                onOpenTrip={onOpenTrip}
              />
            )}

            {isShipper && (
              <div className="bg-[#FAFAF7] border border-[#E4DCC4] rounded p-5 shadow-sm space-y-4">
                <span className="eyebrow block">My Loads</span>
                <h3 className="text-lg font-display-title">Posted lanes</h3>
                {myLoads.length === 0 ? (
                  <p className="font-mono text-xs text-[#5B6168]">No loads posted yet.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {myLoads.map((load) => {
                      const booking = bookingByLoad.get(load.id);
                      const moving = load.status === 'booked' || load.status === 'in_transit';
                      return (
                        <div key={load.id} className="p-4 bg-[#F0EAD8] border border-[#E4DCC4] rounded space-y-1 font-mono text-xs">
                          <div className="font-bold text-sm text-[#14171A]">
                            {load.id} · {load.origin_city}, {load.origin_state} &rarr; {load.dest_city}, {load.dest_state}
                          </div>
                          <div>Status: {load.status.replace('_', ' ')}</div>
                          <div>
                            {Number(load.miles).toLocaleString()} mi · ${Number(load.rate_per_mile).toFixed(2)}/mi
                          </div>
                          <div className="pt-2 flex flex-wrap gap-2">
                            <button
                              onClick={() => setOpenLoad(load)}
                              className="btn ghost py-1.5 px-3 text-xs"
                            >
                              {load.status === 'open' ? 'View & add photos' : 'View load'}
                            </button>
                            {booking && (moving || load.status === 'delivered') && (
                              <button
                                onClick={() => onOpenTrip(booking.id)}
                                className={`btn ${moving ? 'primary' : 'ghost'} py-1.5 px-3 text-xs`}
                              >
                                {moving ? 'Track truck' : 'View trip'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div>
              <h3 className="text-lg font-display-title mb-3">Settled Transaction Ledger</h3>
              <div className="ledger-table-wrap">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>Miles</th>
                      <th>Rate / mi</th>
                      {driverHasPastFees && <th>Past Fee</th>}
                      <th>Net to Carrier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingSettlements ? (
                      <tr>
                        <td colSpan={driverHasPastFees ? 5 : 4} className="text-center py-6 font-mono text-[#5B6168]">
                          Loading settlements...
                        </td>
                      </tr>
                    ) : settlements.length === 0 ? (
                      <tr>
                        <td colSpan={driverHasPastFees ? 5 : 4} className="text-center py-6 font-mono text-[#5B6168]">
                          No settlements posted yet.
                        </td>
                      </tr>
                    ) : (
                      settlements.map((s) => (
                        <tr key={s.id}>
                          <td className="font-bold">
                            {s.origin_city}, {s.origin_state} &rarr; {s.dest_city}, {s.dest_state}
                          </td>
                          <td>{Number(s.miles).toLocaleString()}</td>
                          <td>${Number(s.rate_per_mile).toFixed(2)}</td>
                          {driverHasPastFees && <td className="text-[#5B3D00]">{usd(Number(s.fee_amount))}</td>}
                          <td className="text-[#0F5132] font-bold">{usd(Number(s.net_amount))}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
      {openLoad && <LoadDetail load={openLoad} viewer="owner" onClose={() => setOpenLoad(null)} />}
    </div>
  );
};

function ActiveBookingsPanel({
  bookings,
  isLoading,
  podBusy,
  podError,
  completingId,
  completeError,
  onPodFile,
  onComplete,
  onOpenTrip
}: {
  bookings: BookingWithLoad[];
  isLoading: boolean;
  podBusy: Record<string, boolean>;
  podError: Record<string, string>;
  completingId: string | null;
  completeError: string | null;
  onPodFile: (bookingId: string, file: File) => void;
  onComplete: (bookingId: string) => void;
  onOpenTrip: (bookingId: string) => void;
}) {
  return (
    <div className="bg-[#FAFAF7] border border-[#E4DCC4] rounded p-5 shadow-sm space-y-4">
      <span className="eyebrow block">Active Bookings</span>
      <h3 className="text-lg font-display-title">Upload POD &amp; settle</h3>
      {isLoading ? (
        <p className="font-mono text-xs text-[#5B6168]">Loading bookings...</p>
      ) : bookings.length === 0 ? (
        <p className="font-mono text-xs text-[#5B6168]">No active bookings. Book a load from the board.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {bookings.map((booking) => (
            <div key={booking.id} className="p-4 bg-[#F0EAD8] border border-[#E4DCC4] rounded space-y-2 font-mono text-xs">
              <div className="font-bold text-sm text-[#14171A]">
                {booking.load_id} · {booking.origin_city}, {booking.origin_state} &rarr; {booking.dest_city}, {booking.dest_state}
              </div>
              <div>Booking {booking.id} · {booking.load_status.replace('_', ' ')}</div>
              <button onClick={() => onOpenTrip(booking.id)} className="btn amber py-1.5 px-3 text-xs">
                Open trip map
              </button>
              <div>
                Miles: {Number(booking.miles).toLocaleString()} · Rate: ${Number(booking.rate_per_mile).toFixed(2)}/mi
              </div>
              <div>Gross: {usd(Number(booking.miles) * Number(booking.rate_per_mile))}</div>
              {booking.pod_url ? (
                <div className="text-[#0F5132] font-bold">POD attached</div>
              ) : (
                <label className="block">
                  <span className="uppercase font-bold text-[#5B6168]">Proof of delivery</span>
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    disabled={podBusy[booking.id]}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onPodFile(booking.id, file);
                    }}
                    className="mt-1 block w-full text-[0.7rem]"
                  />
                </label>
              )}
              {podBusy[booking.id] && <div className="text-[#5B6168]">Uploading POD...</div>}
              {podError[booking.id] && <div className="text-[#8C2F1B]">{podError[booking.id]}</div>}
              {completeError && completingId === booking.id && (
                <div className="text-[#8C2F1B]">{completeError}</div>
              )}
              <div className="pt-2 border-t border-[#E4DCC4]">
                <button
                  onClick={() => onComplete(booking.id)}
                  disabled={completingId === booking.id}
                  className="btn primary py-1.5 px-3 text-xs"
                >
                  {completingId === booking.id ? 'Settling...' : 'Complete & Post to Open Books'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
