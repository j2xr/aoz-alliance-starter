const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function extensionFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/**
 * Returns true if the attachment looks like a supported image.
 * Checks contentType first; falls back to filename extension when
 * Discord omits the MIME type (contentType === null).
 */
export function isImageAttachment(
  contentType: string | null,
  filename: string,
): boolean {
  if (contentType) {
    return IMAGE_MIME_TYPES.has(contentType.split(';')[0]?.trim() ?? '');
  }
  return IMAGE_EXTENSIONS.has(extensionFromFilename(filename));
}
