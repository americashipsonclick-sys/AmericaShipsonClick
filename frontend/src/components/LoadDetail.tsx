import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  appointment,
  dayAndTime,
  equipmentLabel,
  loadTypeLabel,
  longDay,
  monthYear,
  requirements,
  timeAgo
} from '../lib/loadFormat';
import { MAX_LOAD_PHOTOS, PHOTO_ACCEPT, shrinkPhoto } from '../lib/loadPhotos';
import { isFactored, pctLabel, settlementPreview, usd } from '../lib/settlementPreview';
import type { Booking, Load, LoadPhoto } from '../types/api';

interface LoadDetailProps {
  load: Load;
  /** A carrier can book from here; the shipper who posted it manages its photos. */
  viewer: 'carrier' | 'owner';
  /** The signed-in driver's same-day preference, which decides the factor at settlement. */
  driverOptIn?: boolean | null;
  onClose: () => void;
  onBooked?: (booking: Booking) => void;
}

const boxClass = 'bg-[#FAFAF7] border-2 border-[#14171A] p-4 sm:p-5';

/** A labelled value that stays off the page when the shipper did not state it. */
const Field: React.FC<{ label: string; value?: React.ReactNode }> = ({ label, value }) => {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div>
      <div className="font-mono text-[0.68rem] uppercase tracking-wider text-[#5B6168]">{label}</div>
      <div className="font-mono text-xs font-bold text-[#14171A] break-words">{value}</div>
    </div>
  );
};

const StopLine: React.FC<{ label: string; value?: string | null }> = ({ label, value }) => {
  if (!value) return null;
  return (
    <p className="font-mono text-xs text-[#14171A]">
      <strong>{label}:</strong> {value}
    </p>
  );
};

const PhotoTile: React.FC<{
  loadId: string;
  photo: LoadPhoto;
  onRemove?: () => void;
  removing?: boolean;
}> = ({ loadId, photo, onRemove, removing }) => {
  // The image route needs the sign-in token, which an <img> tag cannot send.
  const { data: blob, isError } = useQuery({
    queryKey: ['load-photo', loadId, photo.id],
    queryFn: () => api.getLoadPhoto(loadId, photo.id),
    staleTime: Infinity
  });
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  const alt = photo.caption || 'Freight photo';

  return (
    <figure className="m-0 min-w-0">
      <div className="aspect-[4/3] border-2 border-[#14171A] bg-[#E4DCC4] flex items-center justify-center overflow-hidden">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="block w-full h-full" title="Open full size">
            <img src={url} alt={alt} className="w-full h-full object-cover" />
          </a>
        ) : (
          <span className="font-mono text-[0.7rem] text-[#5B6168]">
            {isError ? 'Photo unavailable' : 'Loading…'}
          </span>
        )}
      </div>
      <figcaption className="mt-1 font-mono text-[0.68rem] text-[#5B6168] break-words">
        {photo.caption && <span className="block font-bold text-[#14171A]">{photo.caption}</span>}
        Added by shipper · {dayAndTime(photo.created_at)}
      </figcaption>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="mt-1 font-mono text-[0.7rem] font-bold uppercase text-[#8C2F1B] underline bg-transparent border-none p-0 cursor-pointer"
        >
          {removing ? 'Removing…' : 'Remove'}
        </button>
      )}
    </figure>
  );
};

const AddPhotoTile: React.FC<{ loadId: string }> = ({ loadId }) => {
  const queryClient = useQueryClient();
  const [caption, setCaption] = useState('');

  const addPhoto = useMutation({
    mutationFn: async (file: File) => api.addLoadPhoto(loadId, await shrinkPhoto(file), caption),
    onSuccess: () => {
      setCaption('');
      queryClient.invalidateQueries({ queryKey: ['load', loadId] });
    }
  });

  return (
    <div className="border-2 border-dashed border-[#14171A] p-3 flex flex-col gap-2 justify-center min-w-0">
      <label className="block font-mono text-[0.68rem] uppercase font-bold text-[#5B6168]">
        Caption (optional)
        <input
          type="text"
          maxLength={120}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="e.g. Pallets wrapped at dock 7"
          className="mt-1 w-full p-2 bg-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs normal-case font-normal"
        />
      </label>
      <label className={`btn ghost block text-center py-2 text-xs cursor-pointer ${addPhoto.isPending ? 'opacity-60' : ''}`}>
        {addPhoto.isPending ? 'Uploading…' : 'Add photo'}
        <input
          type="file"
          accept={PHOTO_ACCEPT}
          disabled={addPhoto.isPending}
          aria-label="Add freight photo"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) addPhoto.mutate(file);
          }}
        />
      </label>
      {addPhoto.error && <p className="font-mono text-[0.7rem] text-[#8C2F1B]">{(addPhoto.error as Error).message}</p>}
    </div>
  );
};

export const LoadDetail: React.FC<LoadDetailProps> = ({ load: listed, viewer, driverOptIn, onClose, onBooked }) => {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [booked, setBooked] = useState(false);

  const { data: config } = useQuery({ queryKey: ['config'], queryFn: () => api.getConfig() });
  const { data: catalog } = useQuery({ queryKey: ['rates'], queryFn: () => api.getRates() });
  const { data: detail, error: detailError } = useQuery({
    queryKey: ['load', listed.id],
    queryFn: () => api.getLoad(listed.id)
  });

  const load: Load = { ...listed, ...detail };
  const photos = detail?.photos ?? [];
  const isOwner = viewer === 'owner';
  const canEditPhotos = isOwner && load.status === 'open';

  const removePhoto = useMutation({
    mutationFn: (photoId: string) => api.removeLoadPhoto(load.id, photoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['load', load.id] })
  });

  const book = useMutation({
    mutationFn: () => api.bookLoad(load.id),
    onSuccess: (booking) => {
      setBooked(true);
      queryClient.invalidateQueries({ queryKey: ['loads'] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
      // Straight to the trip: the map, the road to pickup, and location sharing.
      setTimeout(() => onBooked?.(booking), 900);
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = settlementPreview(load.miles, load.rate_per_mile, config, {
    factored: isFactored(load.same_day_funding_offered, viewer === 'carrier' ? driverOptIn : null)
  });
  const originLine = `${load.origin_city}, ${load.origin_state}${load.origin_zip ? ` ${load.origin_zip}` : ''}`;
  const destLine = `${load.dest_city}, ${load.dest_state}${load.dest_zip ? ` ${load.dest_zip}` : ''}`;
  const typeLabel = loadTypeLabel(load);
  const shipperFacts = [
    load.shipper_member_since && `Member since ${monthYear(load.shipper_member_since)}`,
    load.shipper_loads_posted != null
      && `${load.shipper_loads_posted} load${load.shipper_loads_posted === 1 ? '' : 's'} posted`
  ].filter(Boolean).join(' · ');

  return (
    <div
      className="fixed inset-0 bg-[#14171A]/80 z-[2000] overflow-y-auto p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-detail-title"
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#F0EAD8] border-4 border-[#14171A] shadow-[10px_10px_0px_#14171A] max-w-3xl mx-auto p-4 sm:p-6 space-y-4"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-3 text-2xl font-bold bg-transparent border-none cursor-pointer text-[#14171A]"
        >
          &times;
        </button>

        <header className="pr-6">
          <p className="font-mono text-[0.7rem] uppercase tracking-wider text-[#5B6168] mb-1">
            Load {load.id} · Posted {timeAgo(load.created_at)}
          </p>
          <h3 id="load-detail-title" className="text-xl sm:text-2xl font-serif font-black leading-tight text-[#14171A] mb-2">
            {originLine} <span className="text-[#E3A008]">&rarr;</span> {destLine}
          </h3>
          <div className="flex flex-wrap gap-2 font-mono text-[0.7rem] font-bold uppercase">
            <span className="bg-[#14171A] text-[#F0EAD8] px-2 py-1">{equipmentLabel(load, catalog)}</span>
            {typeLabel && <span className="bg-[#E3A008] text-[#14171A] px-2 py-1">{typeLabel}</span>}
          </div>
        </header>

        {detailError && (
          <div className="p-3 bg-[#8C2F1B]/10 border-2 border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs">
            {(detailError as Error).message}
          </div>
        )}

        {load.shipper_name && (
          <section className={boxClass}>
            <span className="eyebrow block mb-1">Shipper</span>
            <p className="font-serif font-black text-lg leading-tight text-[#14171A]">{load.shipper_name}</p>
            {shipperFacts && <p className="font-mono text-xs text-[#5B6168] mt-1">{shipperFacts}</p>}
          </section>
        )}

        {(photos.length > 0 || canEditPhotos) && (
          <section className={boxClass}>
            <span className="eyebrow block mb-3">Freight Photos</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {photos.map((photo) => (
                <PhotoTile
                  key={photo.id}
                  loadId={load.id}
                  photo={photo}
                  removing={removePhoto.isPending && removePhoto.variables === photo.id}
                  onRemove={canEditPhotos ? () => {
                    if (window.confirm('Remove this photo from the load?')) removePhoto.mutate(photo.id);
                  } : undefined}
                />
              ))}
              {canEditPhotos && detail && photos.length < MAX_LOAD_PHOTOS && <AddPhotoTile loadId={load.id} />}
            </div>
            {removePhoto.error && (
              <p className="mt-2 font-mono text-[0.7rem] text-[#8C2F1B]">{(removePhoto.error as Error).message}</p>
            )}
            {canEditPhotos && (
              <p className="mt-3 font-mono text-[0.7rem] text-[#5B6168]">
                Up to {MAX_LOAD_PHOTOS} photos. JPEG, PNG or WebP. Drivers see them here while the load is open.
              </p>
            )}
          </section>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <section className={`${boxClass} space-y-1`}>
            <span className="eyebrow block mb-1">Pickup</span>
            {load.origin_street && <p className="font-mono text-sm font-bold text-[#14171A]">{load.origin_street}</p>}
            <p className="font-mono text-xs text-[#14171A] mb-2">{originLine}</p>
            <StopLine label="Date" value={longDay(load.pickup_date)} />
            <StopLine label="Appointment" value={appointment(load.pickup_appt_start, load.pickup_appt_end)} />
            <StopLine label="Dock" value={load.pickup_dock} />
            <StopLine label="Park / stage" value={load.pickup_parking} />
            <StopLine label="Check-in" value={load.pickup_checkin} />
          </section>

          <section className={`${boxClass} space-y-1`}>
            <span className="eyebrow block mb-1">Delivery</span>
            {load.dest_street && <p className="font-mono text-sm font-bold text-[#14171A]">{load.dest_street}</p>}
            <p className="font-mono text-xs text-[#14171A] mb-2">{destLine}</p>
            <StopLine label="Date" value={load.delivery_date ? longDay(load.delivery_date) : undefined} />
            <StopLine label="Appointment" value={appointment(load.delivery_appt_start, load.delivery_appt_end)} />
            <StopLine label="Dock" value={load.delivery_dock} />
            <StopLine label="Park" value={load.delivery_parking} />
            <StopLine label="Receiving hours" value={load.receiving_hours} />
          </section>
        </div>

        <section className={boxClass}>
          <span className="eyebrow block mb-3">Load Details</span>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Field label="Equipment" value={equipmentLabel(load, catalog)} />
            <Field label="Load type" value={typeLabel} />
            <Field label="Weight" value={load.weight_lbs ? `${Number(load.weight_lbs).toLocaleString()} lbs` : undefined} />
            <Field label="Pallets" value={load.pallets} />
            <Field label="Commodity" value={load.commodity} />
            <Field label="Temperature" value={load.temperature_f != null ? `${load.temperature_f}°F` : undefined} />
            <Field label="Hazmat" value={load.hazmat == null ? undefined : load.hazmat ? 'Yes' : 'No'} />
            <Field label="Requires" value={requirements(load)} />
            <Field label="Miles" value={preview.miles.toLocaleString()} />
            <Field label="Rate / mile" value={`$${preview.ratePerMile.toFixed(2)}`} />
            <Field label="Total gross" value={usd(preview.gross)} />
            <Field label="Notes" value={load.notes} />
          </div>
        </section>

        <div className={`grid grid-cols-1 ${isOwner ? '' : 'sm:grid-cols-2'} gap-4 items-start`}>
          <section className="bg-[#F4F7F2] border-2 border-[#14171A] p-4 sm:p-5 font-mono text-xs space-y-2">
            <span className="eyebrow block">Pay</span>
            <div className="flex justify-between gap-3">
              <span>Total gross</span>
              <span className="font-bold">{usd(preview.gross)}</span>
            </div>
            {preview.factored && (
              <div className="flex justify-between gap-3 text-[#5B6168]">
                <span>Same-day factor ({pctLabel(preview.factorPct)})</span>
                <span>&minus;{usd(preview.factor)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline gap-3 pt-2 border-t-2 border-[#14171A]">
              <span className="font-bold">{isOwner ? 'Carrier keeps' : 'You keep'}</span>
              <span className="font-serif font-black text-2xl text-[#0F5132]">{usd(preview.net)}</span>
            </div>
            {load.payment_terms && <p className="text-[#5B6168]">Payment terms: {load.payment_terms}</p>}
          </section>

          {!isOwner && (
            <div className="space-y-2">
              {booked ? (
                <div className="p-4 bg-[#0F5132] text-[#F0EAD8] border-2 border-[#14171A] font-mono text-center">
                  ✓ Load booked. Opening your trip map…
                </div>
              ) : load.status !== 'open' ? (
                <div className="p-4 bg-[#FAFAF7] border-2 border-[#14171A] font-mono text-xs text-center">
                  This load is no longer open.
                </div>
              ) : confirming ? (
                <>
                  <button
                    type="button"
                    onClick={() => book.mutate()}
                    disabled={book.isPending}
                    className="btn primary block w-full py-4"
                  >
                    {book.isPending ? 'Confirming…' : 'Confirm & lock booking'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={book.isPending}
                    className="btn ghost block w-full py-2 text-xs"
                  >
                    Not yet
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="btn primary block w-full py-4"
                >
                  Book load direct
                </button>
              )}
              {!booked && load.status === 'open' && (
                <p className="font-mono text-[0.7rem] text-[#5B6168] text-center">
                  Booking locks this load to you right away and opens your trip map.
                </p>
              )}
              {book.error && (
                <div className="p-3 bg-[#8C2F1B]/10 border-2 border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs">
                  {(book.error as Error).message}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
