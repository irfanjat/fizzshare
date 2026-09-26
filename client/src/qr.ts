/**
 * qr.ts — render a share link as a QR code on a <canvas>.
 *
 * Uses the vendored `qrcode-generator` (MIT, Kazuhiko Arase) only — no
 * runtime dependency, so the browser never needs internet to draw the code.
 */

import qrcode from './vendor/qrcode';

/** Draw `text` (the share URL) into `canvas` at a crisp, device-pixel size. */
export function renderShareQr(canvas: HTMLCanvasElement, text: string): void {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const n = qr.getModuleCount();
  const base = 4;
  const size = n * base;
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#14332a';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) ctx.fillRect(c * base, r * base, base, base);
    }
  }
}