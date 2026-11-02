import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LoadBoardMap } from '../components/LoadBoardMap';
import { api } from '../lib/api';
import { lanePlace } from '../lib/laneCoords';
import { Load, User } from '../types/api';
import { pctLabel, settlementPreview, usd, withConfigDefaults } from '../lib/settlementPreview';

interface FindLoadsProps {
  currentUser: User | null;
  onOpenAuth: () => void;
  onOpenTrip: (bookingId: string) => void;
}

export const FindLoads: React.FC<FindLoadsProps> = ({ currentUser, onOpenAuth, onOpenTrip }) => {
  const queryClient = useQueryClient();

  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [equipment, setEquipment] = useState('Any');
  const [minRate, setMinRate] = useState('');

  const [selectedLoad, setSelectedLoad] = useState<Load | null>(null);
  const [focusedLoadId, setFocusedLoadId] = useState<string | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingSuccess, setBookingSuccess] = useState<boolean>(false);

  // Fetch single source of truth for platform config
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.getConfig()
  });

  const { data: catalog } = useQuery({
    queryKey: ['rates'],
    queryFn: () => api.getRates()
  });

  // Fetch open loads from backend
  const { data: loads = [], isLoading, error } = useQuery({
    queryKey: ['loads', origin, destination, equipment, minRate],
    queryFn: () => api.getLoads({
      origin: origin || undefined,
      destination: destination || undefined,
      equipment: equipment !== 'Any' ? equipment : undefined,
      minRate: minRate ? parseFloat(minRate) : undefined,
      status: 'open'
    })
  });

  // Book load mutation
  const bookMutation = useMutation({
    mutationFn: (loadId: string) => api.bookLoad(loadId),
    onSuccess: (booking) => {
      setBookingSuccess(true);
      setBookingError(null);
      queryClient.invalidateQueries({ queryKey: ['loads'] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
      // Straight to the trip: the map, the road to pickup, and location sharing.
      setTimeout(() => {
        setSelectedLoad(null);
        setBookingSuccess(false);
        onOpenTrip(booking.id);
      }, 900);
    },
    onError: (err: any) => {
      setBookingError(err.message || 'Failed to book load');
    }
  });

  const handleBookClick = (load: Load) => {
    if (!currentUser) {
      onOpenAuth();
      return;
    }
    if (currentUser.role !== 'driver' && currentUser.role !== 'admin') {
      alert('Only driver accounts can book loads. Please switch to a driver account.');
      return;
    }
    setFocusedLoadId(load.id);
    setSelectedLoad(load);
    setBookingError(null);
    setBookingSuccess(false);
  };

  useEffect(() => {
    if (loads.length === 0) {
      setFocusedLoadId(null);
      return;
    }
    setFocusedLoadId((prev) => (prev && loads.some((load) => load.id === prev) ? prev : loads[0].id));
  }, [loads]);

  useEffect(() => {
    if (!selectedLoad) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedLoad(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLoad]);

  return (
    <div className="py-12 bg-[#F0EAD8] text-[#14171A]">
      <div className="max-w-295 mx-auto px-6">
        <span className="eyebrow block mb-1">Find Freight</span>
        <h2 className="text-3xl sm:text-4xl mb-2">Available Load Board</h2>
        <p className="text-[#5B6168] font-sans text-xs sm:text-sm mb-8">
          Open loads plot on the map at the pickup the shipper dropped. Tap a mile pin to see the dock, the drop, and the lane. Filter by address, street, ZIP, city, or equipment. Ledger net is the same math Open Books will publish: gross minus the {pctLabel(withConfigDefaults(config).fee_pct)} platform fee, modeled fuel, and optional same-day factor.
        </p>

        {/* Tactile Filter Bar */}
        <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-5 mb-10 shadow-[6px_6px_0px_#14171A] grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 items-end">
          <div>
            <label className="block text-[0.76rem] uppercase font-mono font-bold tracking-wider text-[#14171A] mb-1">
              Origin
            </label>
            <input
              type="text"
              placeholder="Address, street, city, or ZIP"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs focus:outline-none focus:bg-white"
            />
          </div>
          <div>
            <label className="block text-[0.76rem] uppercase font-mono font-bold tracking-wider text-[#14171A] mb-1">
              Destination
            </label>
            <input
              type="text"
              placeholder="Address, street, city, or ZIP"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs focus:outline-none focus:bg-white"
            />
          </div>
          <div>
            <label className="block text-[0.76rem] uppercase font-mono font-bold tracking-wider text-[#14171A] mb-1">
              Equipment
            </label>
            <select
              value={equipment}
              onChange={(e) => setEquipment(e.target.value)}
              className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs focus:outline-none focus:bg-white"
            >
              <option value="Any">Any Equipment</option>
              {(catalog?.cards ?? []).map(c => (
                <option key={c.equipment_key} value={c.equipment_key}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[0.76rem] uppercase font-mono font-bold tracking-wider text-[#14171A] mb-1">
              Min $/mile
            </label>
            <input
              type="number"
              step="0.05"
              placeholder="e.g. 2.20"
              value={minRate}
              onChange={(e) => setMinRate(e.target.value)}
              className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs focus:outline-none focus:bg-white"
            />
          </div>
          <div>
            <button
              onClick={() => { setOrigin(''); setDestination(''); setEquipment('Any'); setMinRate(''); }}
              className="btn ghost block w-full py-2.5 text-xs"
            >
              Reset Filters
            </button>
          </div>
        </div>

        {/* Load Grid */}
        {isLoading ? (
          <div className="py-12 text-center font-mono text-[#5B6168]">
            Loading available loads from database...
          </div>
        ) : error ? (
          <div className="p-4 bg-[#8C2F1B]/10 border-2 border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs">
            {(error as Error).message}
          </div>
        ) : loads.length === 0 ? (
          <div className="p-12 bg-[#FAFAF7] border-2 border-[#14171A] text-center text-[#5B6168] font-mono shadow-[4px_4px_0px_#14171A]">
            No loads match your search criteria. Try widening your filters.
          </div>
        ) : (
          <>
          <LoadBoardMap
            loads={loads}
            focusedId={focusedLoadId}
            catalog={catalog}
            config={config}
            onFocus={setFocusedLoadId}
            onBook={handleBookClick}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {loads.map((load) => {
              const preview = settlementPreview(load.miles, load.rate_per_mile, config, {
                factored: load.same_day_funding_offered
              });
              const pickup = lanePlace(load.origin_city, load.origin_state, load.origin_address);
              const drop = lanePlace(load.dest_city, load.dest_state, load.dest_address);
              const focused = focusedLoadId === load.id;

              return (
                <div
                  key={load.id}
                  id={`load-${load.id}`}
                  onClick={() => setFocusedLoadId(load.id)}
                  className={`border-2 border-[#14171A] p-5 shadow-[4px_4px_0px_#14171A] flex flex-col justify-between gap-4 cursor-pointer ${focused ? 'bg-[#F4F7F2] outline outline-2 outline-[#0F5132] -outline-offset-2' : 'bg-[#FAFAF7]'}`}
                >
                  <div>
                    <div className="flex justify-between items-start mb-3">
                      <span className="font-serif font-black text-xl uppercase leading-tight text-[#14171A]">
                        {pickup} <span className="text-[#E3A008]">&rarr;</span> {drop}
                      </span>
                    </div>

                    <div className="inline-block bg-[#14171A] text-[#F0EAD8] font-mono font-bold text-[0.78rem] uppercase px-2.5 py-1 mb-4">
                      EQUIPMENT: {catalog?.cards.find(c => c.equipment_key === load.equipment_type)?.label
                        || load.equipment_type.replaceAll('_', ' ')}
                    </div>

                    <div className="grid grid-cols-2 gap-3 font-mono text-xs mb-4">
                      <div>
                        <div className="text-[#5B6168] text-[0.78rem] uppercase font-bold">Miles</div>
                        <div className="font-bold text-sm">{preview.miles.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-[#5B6168] text-[0.78rem] uppercase font-bold">Total Gross</div>
                        <div className="font-bold text-sm">{usd(preview.gross)}</div>
                      </div>
                      <div>
                        <div className="text-[#5B6168] text-[0.78rem] uppercase font-bold">Rate / Mile</div>
                        <div className="font-bold text-sm text-[#0F5132]">${preview.ratePerMile.toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-[#5B6168] text-[0.78rem] uppercase font-bold">Pickup Date</div>
                        <div className="font-bold text-sm">{load.pickup_date}</div>
                      </div>
                    </div>

                    <div className="bg-[#F0EAD8] border-2 border-[#14171A] p-3 font-mono text-xs mb-4 space-y-1">
                      <div className="flex justify-between">
                        <span>Platform fee ({pctLabel(preview.feePct)})</span>
                        <span>&minus;{usd(preview.fee)}</span>
                      </div>
                      <div className="flex justify-between text-[#5B6168]">
                        <span>Modeled fuel (${preview.fuelRate.toFixed(2)}/mi)</span>
                        <span>&minus;{usd(preview.fuel)}</span>
                      </div>
                      {preview.factored && (
                        <div className="flex justify-between text-[#5B6168]">
                          <span>Same-day factor ({pctLabel(preview.factorPct)})</span>
                          <span>&minus;{usd(preview.factor)}</span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold pt-1 border-t border-[#14171A]/20">
                        <span className="text-[#14171A]">Ledger net</span>
                        <span className="text-[#0F5132] text-sm">{usd(preview.net)}</span>
                      </div>
                    </div>

                    {load.notes && (
                      <div className="text-xs text-[#5B6168] font-mono italic mb-2">
                        "{load.notes}"
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBookClick(load);
                    }}
                    className="btn primary block w-full py-3 text-xs"
                  >
                    Book Load Direct
                  </button>
                </div>
              );
            })}
          </div>
          </>
        )}

        {/* BOOKING MODAL */}
        {selectedLoad && (
          <div className="fixed inset-0 bg-[#14171A]/80 flex items-center justify-center z-50 p-4">
            <div className="bg-[#FAFAF7] border-4 border-[#14171A] max-w-md w-full p-6 shadow-[10px_10px_0px_#14171A] relative">
              <button
                onClick={() => setSelectedLoad(null)}
                className="absolute top-3 right-4 text-2xl font-bold bg-transparent border-none cursor-pointer text-[#14171A]"
              >
                &times;
              </button>

              <span className="eyebrow block mb-1">Confirm Load Booking</span>
              <h3 className="text-2xl font-serif font-black uppercase mb-4 text-[#14171A]">
                {selectedLoad.origin_address || `${selectedLoad.origin_city}, ${selectedLoad.origin_state}`} &rarr; {selectedLoad.dest_address || `${selectedLoad.dest_city}, ${selectedLoad.dest_state}`}
              </h3>

              {bookingSuccess ? (
                <div className="p-4 bg-[#0F5132] text-[#F0EAD8] border-2 border-[#14171A] font-mono text-center mb-4">
                  ✓ Load Booked! Opening your trip map…
                </div>
              ) : (
                <>
                  {(() => {
                    const preview = settlementPreview(selectedLoad.miles, selectedLoad.rate_per_mile, config, {
                      factored: selectedLoad.same_day_funding_offered
                    });
                    return (
                      <div className="space-y-2 font-mono text-xs border-y-2 border-[#14171A] py-3 mb-4">
                        <div className="flex justify-between">
                          <span>Total Gross Rate:</span>
                          <span className="font-bold">{usd(preview.gross)}</span>
                        </div>
                        <div className="flex justify-between text-[#8C2F1B]">
                          <span>Platform Fee ({pctLabel(preview.feePct)}):</span>
                          <span>&minus;{usd(preview.fee)}</span>
                        </div>
                        <div className="flex justify-between text-[#5B6168]">
                          <span>Modeled fuel (${preview.fuelRate.toFixed(2)}/mi):</span>
                          <span>&minus;{usd(preview.fuel)}</span>
                        </div>
                        {preview.factored && (
                          <div className="flex justify-between text-[#5B6168]">
                            <span>Same-day factor ({pctLabel(preview.factorPct)}):</span>
                            <span>&minus;{usd(preview.factor)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-[#0F5132] font-bold text-sm pt-2 border-t-2 border-dashed border-[#14171A]">
                          <span>Ledger net (Open Books):</span>
                          <span>{usd(preview.net)}</span>
                        </div>
                      </div>
                    );
                  })()}

                  {bookingError && (
                    <div className="p-3 bg-[#8C2F1B]/10 border-2 border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs mb-4">
                      {bookingError}
                    </div>
                  )}

                  <button
                    onClick={() => bookMutation.mutate(selectedLoad.id)}
                    disabled={bookMutation.isPending}
                    className="btn primary block w-full py-3.5"
                  >
                    {bookMutation.isPending ? 'Confirming Transaction...' : 'Confirm & Lock Booking'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

