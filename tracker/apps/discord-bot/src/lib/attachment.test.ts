import { describe, it, expect } from 'vitest';
import { isImageAttachment } from './attachment.js';

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
