export const MAX_LOAD_PHOTOS = 3;
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

const MAX_EDGE_PX = 1600;

/**
 * Shrinks a photo before upload. Photos live in Postgres and a phone shot can be
 * many megabytes; this also drops the file's metadata, including any location.
 * A browser that cannot read the file sends it as is, and the server decides.
 */
export async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const shrunk = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return shrunk ?? file;
  } catch {
    return file;
  }
}
