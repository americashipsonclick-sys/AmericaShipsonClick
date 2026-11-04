import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { EquipmentType, GeoPlace, User } from '../types/api';
import { pctLabel, settlementPreview, usd } from '../lib/settlementPreview';
import { LaneMap } from '../components/LaneMap';
import { MAX_LOAD_PHOTOS, PHOTO_ACCEPT, shrinkPhoto } from '../lib/loadPhotos';

interface PostLoadProps {
  currentUser: User | null;
  onOpenAuth: () => void;
  setActiveTab: (tab: string) => void;
}

function localISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface PendingPhoto {
  key: string;
  file: File;
  url: string;
  caption: string;
}

const LABEL_CLASS = 'block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1';
const INPUT_CLASS = 'w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono';

/** The optional fields of a load, as typed; blanks are left out of the request. */
const EMPTY_DETAILS = {
  load_type: '',
  pickup_appt_start: '',
  pickup_appt_end: '',
  pickup_dock: '',
  pickup_parking: '',
  pickup_checkin: '',
  delivery_date: '',
  delivery_appt_start: '',
  delivery_appt_end: '',
  delivery_dock: '',
  delivery_parking: '',
  receiving_hours: '',
  pallets: '',
  commodity: '',
  temperature_f: '',
  hazmat: '',
  payment_terms: ''
};

export const PostLoad: React.FC<PostLoadProps> = ({ currentUser, onOpenAuth, setActiveTab }) => {
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.getConfig()
  });

  const { data: catalog } = useQuery({
    queryKey: ['rates'],
    queryFn: () => api.getRates()
  });

  const { data: savedPlaces } = useQuery({
    queryKey: ['shipper-locations'],
    queryFn: () => api.getShipperLocations(),
    enabled: !!currentUser && (currentUser.role === 'shipper' || currentUser.role === 'admin')
  });

  const [origin, setOrigin] = useState<GeoPlace | null>(null);
  const [dest, setDest] = useState<GeoPlace | null>(null);
  const [miles, setMiles] = useState<number>(0);
  const [ratePerMile, setRatePerMile] = useState<number>(2.18);
  const [rateOverridden, setRateOverridden] = useState(false);
  const [equipmentType, setEquipmentType] = useState<EquipmentType>('dry_van');
  const [pickupDate, setPickupDate] = useState<string>(localISODate);
  const [weightLbs, setWeightLbs] = useState<number>(42000);
  const [sameDayFundingOffered, setSameDayFundingOffered] = useState<boolean>(false);
  const [notes, setNotes] = useState<string>('');
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [requiresTwic, setRequiresTwic] = useState(false);
  const [requiresTeam, setRequiresTeam] = useState(false);
  const [requiresLoadBars, setRequiresLoadBars] = useState(false);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [deadheadMiles, setDeadheadMiles] = useState<number>(0);
  const [demandMultiplier, setDemandMultiplier] = useState<number>(1);
  const [express, setExpress] = useState(false);
  const [accessorials, setAccessorials] = useState<string[]>([]);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data: quote } = useQuery({
    queryKey: ['quote', equipmentType, miles, deadheadMiles, demandMultiplier, express, accessorials],
    queryFn: () => api.previewQuote({
      equipment_key: equipmentType,
      miles,
      deadhead_miles: deadheadMiles,
      demand_multiplier: demandMultiplier,
      express,
      accessorials
    }),
    enabled: miles >= 1
  });

  useEffect(() => {
    if (!quote || rateOverridden) return;
    setRatePerMile(quote.quoted_rate_per_mile);
  }, [quote, rateOverridden]);

  const preview = settlementPreview(miles, ratePerMile, config, {
    factored: sameDayFundingOffered
  });

  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url)), []);

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const room = MAX_LOAD_PHOTOS - photos.length;
    const added = Array.from(files).slice(0, room).map((file) => ({
      key: `${file.name}-${file.lastModified}-${Math.random()}`,
      file,
      url: URL.createObjectURL(file),
      caption: ''
    }));
    setPhotos((prev) => [...prev, ...added]);
  };

  const removePhoto = (key: string) => {
    setPhotos((prev) => prev.filter((photo) => {
      if (photo.key === key) URL.revokeObjectURL(photo.url);
      return photo.key !== key;
    }));
  };

  const setDetail = (field: keyof typeof EMPTY_DETAILS) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setDetails((prev) => ({ ...prev, [field]: e.target.value }));

  const createLoadMutation = useMutation({
    mutationFn: async (data: Parameters<typeof api.createLoad>[0]) => {
      const newLoad = await api.createLoad(data);
      // The load is posted by now, so a failed photo must not read as a failed post.
      const failed: string[] = [];
      for (const photo of photos) {
        try {
          await api.addLoadPhoto(newLoad.id, await shrinkPhoto(photo.file), photo.caption);
        } catch (err) {
          failed.push(`${photo.file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
        }
      }
      return { newLoad, failed };
    },
    onSuccess: ({ newLoad, failed }) => {
      setSuccessMsg(`Load ${newLoad.id} posted at $${Number(newLoad.rate_per_mile).toFixed(2)}/mi.`);
      setErrorMsg(failed.length
        ? `Load posted, but these photos did not upload (you can add them from your dashboard): ${failed.join('; ')}`
        : null);
      queryClient.invalidateQueries({ queryKey: ['loads'] });
      queryClient.invalidateQueries({ queryKey: ['shipper-locations'] });
      setTimeout(() => setActiveTab('dashboard'), failed.length ? 6000 : 700);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Failed to post load');
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      onOpenAuth();
      return;
    }
    if (currentUser.role !== 'shipper' && currentUser.role !== 'admin') {
      alert('Only shipper or admin accounts can post loads. Please switch account role.');
      return;
    }

    if (!origin || !dest) {
      setErrorMsg('Drop pickup and destination on the map, or search both locations.');
      return;
    }
    if (!miles || miles < 1) {
      setErrorMsg('Need a lane distance before posting.');
      return;
    }

    if (details.delivery_date && details.delivery_date < pickupDate) {
      setErrorMsg('Delivery date cannot be before the pickup date.');
      return;
    }
    if (details.pickup_appt_start && details.pickup_appt_end && details.pickup_appt_end <= details.pickup_appt_start) {
      setErrorMsg('Pickup appointment must end after it starts.');
      return;
    }
    if (details.delivery_appt_start && details.delivery_appt_end && details.delivery_appt_end <= details.delivery_appt_start) {
      setErrorMsg('Delivery appointment must end after it starts.');
      return;
    }

    setErrorMsg(null);
    setSuccessMsg(null);

    const stated = (value: string) => value.trim() || undefined;
    const statedNumber = (value: string) => (value.trim() === '' ? undefined : Number(value));

    createLoadMutation.mutate({
      origin_city: origin.city,
      origin_state: origin.state.toUpperCase(),
      dest_city: dest.city,
      dest_state: dest.state.toUpperCase(),
      origin_street: origin.street,
      origin_zip: origin.zip,
      origin_address: origin.label,
      dest_street: dest.street,
      dest_zip: dest.zip,
      dest_address: dest.label,
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      dest_lat: dest.lat,
      dest_lng: dest.lng,
      miles,
      rate_per_mile: rateOverridden ? ratePerMile : undefined,
      equipment_type: equipmentType,
      pickup_date: pickupDate,
      weight_lbs: weightLbs,
      same_day_funding_offered: sameDayFundingOffered,
      notes,
      deadhead_miles: deadheadMiles,
      demand_multiplier: demandMultiplier,
      express,
      accessorial_codes: accessorials,
      load_type: (details.load_type || undefined) as 'full_truckload' | 'partial' | undefined,
      pickup_appt_start: stated(details.pickup_appt_start),
      pickup_appt_end: stated(details.pickup_appt_end),
      pickup_dock: stated(details.pickup_dock),
      pickup_parking: stated(details.pickup_parking),
      pickup_checkin: stated(details.pickup_checkin),
      delivery_date: stated(details.delivery_date),
      delivery_appt_start: stated(details.delivery_appt_start),
      delivery_appt_end: stated(details.delivery_appt_end),
      delivery_dock: stated(details.delivery_dock),
      delivery_parking: stated(details.delivery_parking),
      receiving_hours: stated(details.receiving_hours),
      pallets: statedNumber(details.pallets),
      commodity: stated(details.commodity),
      temperature_f: statedNumber(details.temperature_f),
      hazmat: details.hazmat === '' ? undefined : details.hazmat === 'yes',
      requires_twic: requiresTwic,
      requires_team: requiresTeam,
      requires_load_bars: requiresLoadBars,
      payment_terms: stated(details.payment_terms)
    });
  };

  const toggleAccessorial = (code: string) => {
    setAccessorials(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  };

  const card = catalog?.cards.find(c => c.equipment_key === equipmentType);

  return (
    <div className="py-12">
      <div className="max-w-295 mx-auto px-6">
        <span className="eyebrow block mb-1">Shipper Portal</span>
        <h2 className="text-2xl sm:text-3xl mb-2">Post a New Freight Load</h2>
        <p className="text-[#5B6168] mb-8">
          Miles come from the map. Search the dock address, street, ZIP, or a city — or reuse a location you have posted before. Price comes from the equipment table: linehaul, distance minimum, deadhead buffer, accessorials, demand, express, then 7% gross.
        </p>

        {errorMsg && (
          <div className="p-3 bg-[#8C2F1B]/10 border border-[#8C2F1B] text-[#8C2F1B] rounded font-mono text-xs mb-6">
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div className="p-4 bg-[#0F5132]/10 border border-[#0F5132] text-[#0F5132] rounded font-mono text-sm mb-6">
            {successMsg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <form onSubmit={handleSubmit} className="lg:col-span-7 bg-[#FAFAF7] border border-[#E4DCC4] rounded p-6 shadow-sm space-y-4">
            <h3 className="text-lg font-display-title mb-2">Lane Specifications</h3>

            <LaneMap
              origin={origin}
              dest={dest}
              savedPlaces={savedPlaces}
              onOriginChange={setOrigin}
              onDestChange={setDest}
              onMilesChange={(m) => { setMiles(m); setRateOverridden(false); }}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Miles
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  value={miles || ''}
                  onChange={(e) => { setMiles(parseFloat(e.target.value) || 0); setRateOverridden(false); }}
                  placeholder="From map"
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Posted rate ($ / mile)
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={ratePerMile}
                  onChange={(e) => {
                    setRatePerMile(parseFloat(e.target.value) || 0);
                    setRateOverridden(true);
                  }}
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono"
                />
                {rateOverridden && (
                  <button
                    type="button"
                    className="mt-1 text-[0.7rem] font-mono uppercase text-[#0F5132]"
                    onClick={() => {
                      setRateOverridden(false);
                      if (quote) setRatePerMile(quote.quoted_rate_per_mile);
                    }}
                  >
                    Use table rate
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Equipment
                </label>
                <select
                  value={equipmentType}
                  onChange={(e) => { setEquipmentType(e.target.value as EquipmentType); setRateOverridden(false); }}
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
                >
                  {(catalog?.cards ?? []).map(c => (
                    <option key={c.equipment_key} value={c.equipment_key}>{c.label}</option>
                  ))}
                </select>
                {card && (
                  <p className="mt-1 text-[0.7rem] font-mono text-[#5B6168]">
                    ${card.rate_min_per_mile.toFixed(2)}–${card.rate_max_per_mile.toFixed(2)}/mi
                    {card.short_haul_under_miles
                      ? ` · under ${card.short_haul_under_miles} mi min $${Number(card.short_haul_minimum_charge ?? card.minimum_charge).toFixed(0)}`
                      : ` · min $${card.minimum_charge.toFixed(0)}`}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Pickup Date
                </label>
                <input
                  type="date"
                  required
                  value={pickupDate}
                  onChange={(e) => setPickupDate(e.target.value)}
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Deadhead miles
                </label>
                <input
                  type="number"
                  min={0}
                  value={deadheadMiles || ''}
                  onChange={(e) => setDeadheadMiles(parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Demand ×
                </label>
                <input
                  type="number"
                  step="0.05"
                  min={0.5}
                  max={5}
                  value={demandMultiplier}
                  onChange={(e) => setDemandMultiplier(parseFloat(e.target.value) || 1)}
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#5B6168] mb-1">
                  Weight (lbs)
                </label>
                <input
                  type="number"
                  min={1}
                  value={weightLbs}
                  onChange={(e) => setWeightLbs(parseFloat(e.target.value) || 0)}
                  className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm font-mono"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-4 font-mono text-xs pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={express}
                  onChange={(e) => setExpress(e.target.checked)}
                  className="w-4 h-4 accent-[#0F5132]"
                />
                <span>Express / expedite</span>
              </label>
              {(catalog?.accessorials ?? []).map(a => (
                <label key={a.code} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={accessorials.includes(a.code)}
                    onChange={() => toggleAccessorial(a.code)}
                    className="w-4 h-4 accent-[#0F5132]"
                  />
                  <span>{a.label} ({usd(a.amount)})</span>
                </label>
              ))}
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer font-mono text-xs pt-2">
                <input
                  type="checkbox"
                  checked={sameDayFundingOffered}
                  onChange={(e) => setSameDayFundingOffered(e.target.checked)}
                  className="w-4 h-4 accent-[#0F5132]"
                />
                <span>Offer Same-Day Quick Pay to Motor Carrier (+{pctLabel(preview.factorPct)})</span>
              </label>
            </div>

            <h3 className="text-lg font-display-title pt-4 border-t border-[#E4DCC4]">Freight</h3>
            <p className="font-mono text-[0.7rem] text-[#5B6168] -mt-3">
              Everything from here down is optional. Drivers see what you fill in; blanks stay off the load.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="load-type" className={LABEL_CLASS}>Load type</label>
                <select id="load-type" value={details.load_type} onChange={setDetail('load_type')} className={INPUT_CLASS}>
                  <option value="">Not stated</option>
                  <option value="full_truckload">Full truckload</option>
                  <option value="partial">Partial</option>
                </select>
              </div>
              <div>
                <label htmlFor="pallets" className={LABEL_CLASS}>Pallets</label>
                <input id="pallets" type="number" min={1} max={60} value={details.pallets} onChange={setDetail('pallets')} className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="commodity" className={LABEL_CLASS}>Commodity</label>
                <input id="commodity" type="text" maxLength={120} value={details.commodity} onChange={setDetail('commodity')} placeholder="Packaged dry foods" className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="temperature" className={LABEL_CLASS}>Temperature (°F)</label>
                <input id="temperature" type="number" min={-40} max={120} value={details.temperature_f} onChange={setDetail('temperature_f')} placeholder="Reefer only" className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="hazmat" className={LABEL_CLASS}>Hazmat</label>
                <select id="hazmat" value={details.hazmat} onChange={setDetail('hazmat')} className={INPUT_CLASS}>
                  <option value="">Not stated</option>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </div>
              <div>
                <label htmlFor="payment-terms" className={LABEL_CLASS}>Payment terms</label>
                <input id="payment-terms" type="text" maxLength={120} value={details.payment_terms} onChange={setDetail('payment_terms')} placeholder="How and when you pay" className={INPUT_CLASS} />
              </div>
            </div>

            <div className="flex flex-wrap gap-4 font-mono text-xs">
              <span className="uppercase font-bold text-[#5B6168]">Requires:</span>
              {([
                ['TWIC', requiresTwic, setRequiresTwic],
                ['Team', requiresTeam, setRequiresTeam],
                ['Load bars', requiresLoadBars, setRequiresLoadBars]
              ] as const).map(([label, checked, set]) => (
                <label key={label} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => set(e.target.checked)}
                    className="w-4 h-4 accent-[#0F5132]"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            <div>
              <label htmlFor="notes" className={LABEL_CLASS}>Special handling notes</label>
              <textarea
                id="notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Palletized freight, clean trailer"
                className="w-full p-2.5 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-sm"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4 border-t border-[#E4DCC4]">
              <fieldset className="space-y-3 min-w-0">
                <legend className="text-lg font-display-title mb-2">Pickup</legend>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="pickup-from" className={LABEL_CLASS}>Appt from</label>
                    <input id="pickup-from" type="time" value={details.pickup_appt_start} onChange={setDetail('pickup_appt_start')} className={INPUT_CLASS} />
                  </div>
                  <div>
                    <label htmlFor="pickup-to" className={LABEL_CLASS}>Appt to</label>
                    <input id="pickup-to" type="time" value={details.pickup_appt_end} onChange={setDetail('pickup_appt_end')} className={INPUT_CLASS} />
                  </div>
                </div>
                <div>
                  <label htmlFor="pickup-dock" className={LABEL_CLASS}>Dock</label>
                  <input id="pickup-dock" type="text" maxLength={60} value={details.pickup_dock} onChange={setDetail('pickup_dock')} className={INPUT_CLASS} />
                </div>
                <div>
                  <label htmlFor="pickup-parking" className={LABEL_CLASS}>Parking / staging</label>
                  <textarea id="pickup-parking" rows={2} maxLength={300} value={details.pickup_parking} onChange={setDetail('pickup_parking')} className={INPUT_CLASS} />
                </div>
                <div>
                  <label htmlFor="pickup-checkin" className={LABEL_CLASS}>Check-in</label>
                  <textarea id="pickup-checkin" rows={2} maxLength={300} value={details.pickup_checkin} onChange={setDetail('pickup_checkin')} className={INPUT_CLASS} />
                </div>
              </fieldset>

              <fieldset className="space-y-3 min-w-0">
                <legend className="text-lg font-display-title mb-2">Delivery</legend>
                <div>
                  <label htmlFor="delivery-date" className={LABEL_CLASS}>Delivery date</label>
                  <input id="delivery-date" type="date" min={pickupDate} value={details.delivery_date} onChange={setDetail('delivery_date')} className={INPUT_CLASS} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="delivery-from" className={LABEL_CLASS}>Appt from</label>
                    <input id="delivery-from" type="time" value={details.delivery_appt_start} onChange={setDetail('delivery_appt_start')} className={INPUT_CLASS} />
                  </div>
                  <div>
                    <label htmlFor="delivery-to" className={LABEL_CLASS}>Appt to</label>
                    <input id="delivery-to" type="time" value={details.delivery_appt_end} onChange={setDetail('delivery_appt_end')} className={INPUT_CLASS} />
                  </div>
                </div>
                <div>
                  <label htmlFor="delivery-dock" className={LABEL_CLASS}>Dock</label>
                  <input id="delivery-dock" type="text" maxLength={60} value={details.delivery_dock} onChange={setDetail('delivery_dock')} className={INPUT_CLASS} />
                </div>
                <div>
                  <label htmlFor="delivery-parking" className={LABEL_CLASS}>Parking</label>
                  <textarea id="delivery-parking" rows={2} maxLength={300} value={details.delivery_parking} onChange={setDetail('delivery_parking')} className={INPUT_CLASS} />
                </div>
                <div>
                  <label htmlFor="receiving-hours" className={LABEL_CLASS}>Receiving hours</label>
                  <input id="receiving-hours" type="text" maxLength={120} value={details.receiving_hours} onChange={setDetail('receiving_hours')} placeholder="Mon–Fri 06:00–15:00" className={INPUT_CLASS} />
                </div>
              </fieldset>
            </div>

            <div className="pt-4 border-t border-[#E4DCC4]">
              <h3 className="text-lg font-display-title mb-1">Freight photos</h3>
              <p className="font-mono text-[0.7rem] text-[#5B6168] mb-3">
                Up to {MAX_LOAD_PHOTOS} photos so drivers can see what they are hauling. JPEG, PNG or WebP. You can also add them later from your dashboard.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {photos.map((photo) => (
                  <div key={photo.key} className="min-w-0 space-y-1">
                    <img src={photo.url} alt={photo.file.name} className="w-full aspect-[4/3] object-cover border-2 border-[#14171A]" />
                    <input
                      type="text"
                      maxLength={120}
                      value={photo.caption}
                      aria-label={`Caption for ${photo.file.name}`}
                      placeholder="Caption (optional)"
                      onChange={(e) => {
                        const caption = e.target.value;
                        setPhotos((prev) => prev.map((p) => (p.key === photo.key ? { ...p, caption } : p)));
                      }}
                      className="w-full p-2 bg-[#F0EAD8] border border-[#E4DCC4] rounded text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(photo.key)}
                      className="font-mono text-[0.7rem] font-bold uppercase text-[#8C2F1B] underline bg-transparent border-none p-0 cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {photos.length < MAX_LOAD_PHOTOS && (
                  <label className="btn ghost flex items-center justify-center aspect-[4/3] text-xs cursor-pointer text-center">
                    Add photos
                    <input
                      type="file"
                      accept={PHOTO_ACCEPT}
                      multiple
                      aria-label="Add freight photos"
                      className="sr-only"
                      onChange={(e) => {
                        addPhotos(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={createLoadMutation.isPending}
              className="btn primary block w-full py-3 mt-4"
            >
              {createLoadMutation.isPending
                ? (photos.length ? 'Publishing load and photos...' : 'Publishing Load...')
                : 'Accept quote and publish'}
            </button>
          </form>

          <div className="lg:col-span-5 bg-[#14171A] text-[#FAFAF7] rounded p-6 shadow-md sticky top-24 border border-[#1E2226]">
            <span className="eyebrow on-dark block mb-1">Equipment table quote</span>
            <h3 className="text-xl font-display-title mb-4">
              {quote ? usd(quote.quoted_total) : 'Set miles'}
            </h3>

            {quote ? (
              <div className="space-y-3 font-mono text-xs border-y border-[#FAFAF7]/15 py-4">
                <div className="flex justify-between">
                  <span>Linehaul ({quote.miles} mi × ${quote.applied_rate_per_mile.toFixed(2)}):</span>
                  <span>{usd(quote.linehaul_raw)}</span>
                </div>
                {quote.minimum_applied && (
                  <div className="flex justify-between text-[#E3A008]">
                    <span>Distance minimum:</span>
                    <span>{usd(quote.minimum_floor)}</span>
                  </div>
                )}
                <div className="flex justify-between text-[#C9CDD1]">
                  <span>Deadhead buffer:</span>
                  <span>{usd(quote.deadhead_amount)}</span>
                </div>
                {quote.accessorials_amount > 0 && (
                  <div className="flex justify-between text-[#C9CDD1]">
                    <span>Accessorials:</span>
                    <span>{usd(quote.accessorials_amount)}</span>
                  </div>
                )}
                {quote.demand_multiplier !== 1 && (
                  <div className="flex justify-between">
                    <span>Demand ×{quote.demand_multiplier}:</span>
                    <span>{usd(quote.after_demand)}</span>
                  </div>
                )}
                {quote.express && (
                  <div className="flex justify-between text-[#E3A008]">
                    <span>Express (+{pctLabel(quote.express_surcharge_pct)}):</span>
                    <span>{usd(quote.after_express)}</span>
                  </div>
                )}
                <div className="flex justify-between text-[#E3A008]">
                  <span>7% gross:</span>
                  <span>{usd(quote.gross_markup)}</span>
                </div>
                <div className="flex justify-between text-[#FAFAF7] font-bold text-sm pt-3 border-t border-dashed border-[#FAFAF7]/20">
                  <span>Quoted total / RPM:</span>
                  <span className="text-[#E3A008] text-base">
                    {usd(quote.quoted_total)} · ${quote.quoted_rate_per_mile.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between pt-2 text-[#C9CDD1]">
                  <span>Ledger net after {pctLabel(preview.feePct)} fee:</span>
                  <span>{usd(preview.net)}</span>
                </div>
              </div>
            ) : (
              <p className="font-mono text-xs text-[#C9CDD1] py-4">
                Pick equipment and a distance. Short cargo-van hauls under 100 miles floor at $200; car-carrier moves under 500 miles floor at $500.
              </p>
            )}

            <div className="mt-4 text-[0.78rem] font-mono text-[#C9CDD1] leading-relaxed">
              The accepted total is logged so the table can be tuned later. Open Books takes {pctLabel(preview.feePct)} of posted gross.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
