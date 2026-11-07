import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoadBoardMap } from '../components/LoadBoardMap';
import { LoadDetail } from '../components/LoadDetail';
import { api } from '../lib/api';
import { appointment, equipmentLabel, loadTypeLabel, shortDay, timeAgo } from '../lib/loadFormat';
import { Load, User } from '../types/api';
import { isFactored, settlementPreview, usd } from '../lib/settlementPreview';

interface FindLoadsProps {
  currentUser: User | null;
  onOpenAuth: () => void;
  onOpenTrip: (bookingId: string) => void;
}

export const FindLoads: React.FC<FindLoadsProps> = ({ currentUser, onOpenAuth, onOpenTrip }) => {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [equipment, setEquipment] = useState('Any');
  const [minRate, setMinRate] = useState('');
  const [pickupDate, setPickupDate] = useState('');

  const [selectedLoad, setSelectedLoad] = useState<Load | null>(null);
  const [focusedLoadId, setFocusedLoadId] = useState<string | null>(null);

  // Fetch single source of truth for platform config
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.getConfig()
  });

  // The preference settlement uses, so each load's pay shows what this driver is paid
  const { data: me } = useQuery({
    queryKey: ['me', currentUser?.id],
    queryFn: () => api.getMe(),
    enabled: currentUser?.role === 'driver'
  });
  const driverOptIn = me?.same_day_funding_opt_in;

  const { data: catalog } = useQuery({
    queryKey: ['rates'],
    queryFn: () => api.getRates()
  });

  // Fetch open loads from backend
  const { data: loads = [], isLoading, error } = useQuery({
    queryKey: ['loads', origin, destination, equipment, minRate, pickupDate],
    queryFn: () => api.getLoads({
      origin: origin || undefined,
      destination: destination || undefined,
      equipment: equipment !== 'Any' ? equipment : undefined,
      minRate: minRate ? parseFloat(minRate) : undefined,
      pickupDate: pickupDate || undefined,
      status: 'open'
    })
  });

  const handleViewClick = (load: Load) => {
    if (!currentUser) {
      onOpenAuth();
      return;
    }
    setFocusedLoadId(load.id);
    setSelectedLoad(load);
  };

  useEffect(() => {
    if (loads.length === 0) {
      setFocusedLoadId(null);
      return;
    }
    setFocusedLoadId((prev) => (prev && loads.some((load) => load.id === prev) ? prev : loads[0].id));
  }, [loads]);

  return (
    <div className="py-12 bg-[#F0EAD8] text-[#14171A]">
      <div className="max-w-295 mx-auto px-6">
        <span className="eyebrow block mb-1">Find Freight</span>
        <h2 className="text-3xl sm:text-4xl mb-2">Available Load Board</h2>
        <p className="text-[#5B6168] font-sans text-xs sm:text-sm mb-8">
          Open loads plot on the map at the pickup the shipper dropped. Tap a mile pin to see the lane, or open a load for the dock, the photos and your pay: gross minus the optional same-day factor, the same math Open Books publishes.
        </p>

        {/* Tactile Filter Bar */}
        <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-5 mb-10 shadow-[6px_6px_0px_#14171A] grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 items-end">
          <div>
            <label className="block text-[0.76rem] uppercase font-mono font-bold tracking-wider text-[#14171A] mb-1">
              Origin
            </label>
            <input
              type="text"
              placeholder="City, street or ZIP"
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
              placeholder="City, street or ZIP"
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
            <label htmlFor="pickup-date-filter" className="block text-[0.76rem] uppercase font-mono font-bold tracking-wider text-[#14171A] mb-1">
              Pickup date
            </label>
            <input
              id="pickup-date-filter"
              type="date"
              value={pickupDate}
              onChange={(e) => setPickupDate(e.target.value)}
              className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs focus:outline-none focus:bg-white"
            />
          </div>
          <div>
            <button
              onClick={() => { setOrigin(''); setDestination(''); setEquipment('Any'); setMinRate(''); setPickupDate(''); }}
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
          <LoadBoardMap loads={loads} focusedId={focusedLoadId} onFocus={setFocusedLoadId} />
          <h3 className="text-2xl mb-4">Available loads</h3>
          <div className="space-y-4">
            {loads.map((load) => {
              const preview = settlementPreview(load.miles, load.rate_per_mile, config, {
                factored: isFactored(load.same_day_funding_offered, driverOptIn)
              });
              const focused = focusedLoadId === load.id;
              const pickupWindow = appointment(load.pickup_appt_start, load.pickup_appt_end);
              const haul = [
                loadTypeLabel(load),
                load.temperature_f != null ? `${load.temperature_f}°F` : ''
              ].filter(Boolean).join(' · ');

              return (
                <div
                  key={load.id}
                  id={`load-${load.id}`}
                  onClick={() => setFocusedLoadId(load.id)}
                  className={`border-2 border-[#14171A] p-4 sm:p-5 shadow-[4px_4px_0px_#14171A] cursor-pointer grid grid-cols-2 lg:grid-cols-[minmax(0,2.4fr)_repeat(4,minmax(0,1fr))_auto] gap-4 items-center ${focused ? 'bg-[#F4F7F2] outline outline-2 outline-[#0F5132] -outline-offset-2' : 'bg-[#FAFAF7]'}`}
                >
                  <div className="col-span-2 lg:col-span-1 min-w-0">
                    <div className="font-serif font-black text-lg sm:text-xl leading-tight text-[#14171A]">
                      {load.origin_city}, {load.origin_state} <span className="text-[#E3A008]">&rarr;</span> {load.dest_city}, {load.dest_state}
                    </div>
                    <div className="font-mono text-[0.72rem] text-[#5B6168] mt-1">
                      {load.shipper_name && <>{load.shipper_name} · </>}posted {timeAgo(load.created_at)}
                    </div>
                  </div>

                  <div className="min-w-0 font-mono text-xs">
                    <div className="text-[0.68rem] uppercase tracking-wider text-[#5B6168]">Pickup</div>
                    <div className="font-bold text-sm text-[#14171A]">{shortDay(load.pickup_date)}</div>
                    {pickupWindow && <div className="text-[#5B6168]">{pickupWindow}</div>}
                  </div>

                  <div className="min-w-0 font-mono text-xs">
                    <div className="text-[0.68rem] uppercase tracking-wider text-[#5B6168]">Equipment</div>
                    <div className="font-bold text-sm text-[#14171A]">{equipmentLabel(load, catalog)}</div>
                    {haul && <div className="text-[#5B6168]">{haul}</div>}
                  </div>

                  <div className="min-w-0 font-mono text-xs">
                    <div className="text-[0.68rem] uppercase tracking-wider text-[#5B6168]">Miles{load.weight_lbs ? ' · Weight' : ''}</div>
                    <div className="font-bold text-sm text-[#14171A]">{preview.miles.toLocaleString()} mi</div>
                    {load.weight_lbs && <div className="text-[#5B6168]">{Number(load.weight_lbs).toLocaleString()} lbs</div>}
                  </div>

                  <div className="min-w-0 font-mono text-xs">
                    <div className="text-[0.68rem] uppercase tracking-wider text-[#5B6168]">Gross · $/mi</div>
                    <div className="font-bold text-base text-[#0F5132]">{usd(preview.gross)}</div>
                    <div className="text-[#5B6168]">${preview.ratePerMile.toFixed(2)}/mi</div>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleViewClick(load);
                    }}
                    className="btn primary col-span-2 lg:col-span-1 py-3 px-4 text-xs whitespace-nowrap"
                  >
                    View load
                  </button>
                </div>
              );
            })}
          </div>
          </>
        )}

        {selectedLoad && (
          <LoadDetail
            load={selectedLoad}
            viewer="carrier"
            driverOptIn={driverOptIn}
            onClose={() => setSelectedLoad(null)}
            onBooked={(booking) => {
              setSelectedLoad(null);
              onOpenTrip(booking.id);
            }}
          />
        )}
      </div>
    </div>
  );
};

