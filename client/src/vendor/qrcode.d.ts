/** Minimal type surface for the vendored `qrcode-generator` library (MIT). */
export interface QrCode {
  addData(data: string, mode?: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
  createSvgTag(cellSize?: number, margin?: number): string;
  createDataURL(cellSize?: number, margin?: number): string;
}

declare const qrcode: (typeNumber?: number, errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H') => QrCode;
export default qrcode;