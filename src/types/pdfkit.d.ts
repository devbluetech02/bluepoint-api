declare module 'pdfkit' {
  import { Writable } from 'stream';

  interface PDFDocumentOptions {
    size?: string | [number, number];
    layout?: 'portrait' | 'landscape';
    margin?: number;
    margins?: { top: number; bottom: number; left: number; right: number };
    autoFirstPage?: boolean;
    bufferPages?: boolean;
    info?: {
      Title?: string;
      Author?: string;
      Subject?: string;
      Keywords?: string;
      CreationDate?: Date;
    };
  }

  interface PDFTextOptions {
    align?: 'left' | 'center' | 'right' | 'justify';
    width?: number;
    height?: number;
    ellipsis?: boolean | string;
    columns?: number;
    columnGap?: number;
    indent?: number;
    paragraphGap?: number;
    lineGap?: number;
    wordSpacing?: number;
    characterSpacing?: number;
    fill?: boolean;
    stroke?: boolean;
    link?: string;
    underline?: boolean;
    strike?: boolean;
    oblique?: boolean | number;
    continued?: boolean;
    features?: string[];
    lineBreak?: boolean;
    baseline?: string | number;
  }

  class PDFDocument extends Writable {
    constructor(options?: PDFDocumentOptions);

    x: number;
    y: number;
    page: {
      width: number;
      height: number;
      margins: { top: number; bottom: number; left: number; right: number };
    };

    addPage(options?: PDFDocumentOptions): this;
    end(): void;

    font(name: string, size?: number): this;
    fontSize(size: number): this;
    fillColor(color: string, opacity?: number): this;
    strokeColor(color: string, opacity?: number): this;
    lineWidth(width: number): this;
    opacity(opacity: number): this;
    fillOpacity(opacity: number): this;
    strokeOpacity(opacity: number): this;

    text(text: string, x?: number, y?: number, options?: PDFTextOptions): this;
    widthOfString(text: string, options?: PDFTextOptions): number;
    heightOfString(text: string, options?: PDFTextOptions): number;
    currentLineHeight(includeGap?: boolean): number;

    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    fill(color?: string): this;
    rect(x: number, y: number, w: number, h: number): this;
    roundedRect(x: number, y: number, w: number, h: number, r: number): this;
    circle(x: number, y: number, radius: number): this;
    dash(length: number, options?: { space?: number; phase?: number }): this;
    undash(): this;

    image(src: string | Buffer, x?: number, y?: number, options?: {
      width?: number;
      height?: number;
      fit?: [number, number];
      align?: string;
      valign?: string;
    }): this;

    save(): this;
    restore(): this;
    translate(x: number, y: number): this;
    rotate(angle: number, options?: { origin?: [number, number] }): this;
    scale(xFactor: number, yFactor?: number, options?: { origin?: [number, number] }): this;

    pipe(destination: Writable): Writable;
    on(event: string, callback: (...args: unknown[]) => void): this;

    registerFont(name: string, src: string | Buffer, family?: string): this;
  }

  export = PDFDocument;
}
