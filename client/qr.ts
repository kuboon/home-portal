/**
 * QR code helper shared by the invite UIs.
 *
 * Builds a QR code for `text` as an inline SVG path (dark modules only) plus
 * the module grid size, so callers can render it with their own colors and a
 * quiet-zone margin. Kept dependency-light: one `<path>` for all dark cells.
 */

import qrcode from "qrcode-generator";

export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return { size, d };
}
