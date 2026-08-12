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

/** Minimal shape of the message attachments we care about (also matches the mock in tests). */
export type ImageAttachment = { url: string; name: string; contentType?: string | null };

type MessageLike = {
  attachments: { values(): IterableIterator<ImageAttachment> };
};

/**
 * The message's image attachments, in the attachments' original order — the
 * same order the operator sees, which is what makes the 1-based `image` index
 * of /reprocess and /upload meaningful. Wraps isImageAttachment; does not
 * replace it.
 */
export function imageAttachmentsOf(message: MessageLike): ImageAttachment[] {
  return [...message.attachments.values()].filter((att) =>
    isImageAttachment(att.contentType ?? null, att.name),
  );
}
