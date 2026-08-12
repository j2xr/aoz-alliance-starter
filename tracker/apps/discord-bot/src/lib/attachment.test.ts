import { describe, it, expect } from 'vitest';
import { isImageAttachment, imageAttachmentsOf, type ImageAttachment } from './attachment.js';

function fakeMessage(atts: ImageAttachment[]) {
  return { attachments: { values: () => atts.values() } };
}

describe('isImageAttachment', () => {
  it('accepts known MIME types', () => {
    expect(isImageAttachment('image/png', 'shot.png')).toBe(true);
    expect(isImageAttachment('image/jpeg', 'shot.jpg')).toBe(true);
    expect(isImageAttachment('image/jpg', 'shot.jpg')).toBe(true);
    expect(isImageAttachment('image/webp', 'shot.webp')).toBe(true);
    expect(isImageAttachment('image/gif', 'shot.gif')).toBe(true);
  });

  it('strips MIME parameters before matching', () => {
    expect(isImageAttachment('image/png; charset=utf-8', 'shot.png')).toBe(true);
  });

  it('rejects non-image MIME types', () => {
    expect(isImageAttachment('application/pdf', 'doc.pdf')).toBe(false);
    expect(isImageAttachment('text/plain', 'notes.txt')).toBe(false);
  });

  it('falls back to extension when contentType is null', () => {
    expect(isImageAttachment(null, 'screenshot.png')).toBe(true);
    expect(isImageAttachment(null, 'screenshot.jpg')).toBe(true);
    expect(isImageAttachment(null, 'screenshot.jpeg')).toBe(true);
    expect(isImageAttachment(null, 'screenshot.webp')).toBe(true);
    expect(isImageAttachment(null, 'screenshot.gif')).toBe(true);
  });

  it('extension match is case-insensitive', () => {
    expect(isImageAttachment(null, 'SHOT.PNG')).toBe(true);
    expect(isImageAttachment(null, 'Shot.Jpg')).toBe(true);
  });

  it('rejects non-image extensions when contentType is null', () => {
    expect(isImageAttachment(null, 'document.pdf')).toBe(false);
    expect(isImageAttachment(null, 'archive.zip')).toBe(false);
    expect(isImageAttachment(null, 'noextension')).toBe(false);
  });
});

describe('imageAttachmentsOf', () => {
  it('returns image attachments in the message order (drives the 1-based index)', () => {
    const msg = fakeMessage([
      { url: 'u1', name: 'first.png', contentType: 'image/png' },
      { url: 'u2', name: 'second.jpg', contentType: 'image/jpeg' },
    ]);
    expect(imageAttachmentsOf(msg).map((a) => a.name)).toEqual(['first.png', 'second.jpg']);
  });

  it('skips non-image attachments but keeps the surviving order', () => {
    const msg = fakeMessage([
      { url: 'u1', name: 'notes.pdf', contentType: 'application/pdf' },
      { url: 'u2', name: 'board.png', contentType: 'image/png' },
      { url: 'u3', name: 'archive.zip', contentType: 'application/zip' },
      { url: 'u4', name: 'ranking.jpg', contentType: 'image/jpeg' },
    ]);
    expect(imageAttachmentsOf(msg).map((a) => a.name)).toEqual(['board.png', 'ranking.jpg']);
  });

  it('falls back to the filename extension when contentType is missing', () => {
    const msg = fakeMessage([{ url: 'u1', name: 'shot.png', contentType: null }]);
    expect(imageAttachmentsOf(msg)).toHaveLength(1);
  });

  it('returns [] on a message with no attachments', () => {
    expect(imageAttachmentsOf(fakeMessage([]))).toEqual([]);
  });
});
