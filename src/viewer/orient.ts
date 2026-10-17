/** A 16×8 JPEG (left half red, right half blue) tagged with EXIF orientation 6. */
const TEST_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4vr5Door+qP2Zf/NV/wDcj/7uH9qftDP+aZ/7nf8A3UP/2Q==";

let detected: Promise<boolean> | null = null;

/**
 * Whether drawing an <img> onto a canvas already applies its EXIF orientation. Modern
 * engines do, but WebKitGTK builds vary, so it is measured once rather than assumed.
 */
export function canvasAppliesOrientation(): Promise<boolean> {
  detected ??= (async () => {
    const img = new Image();
    img.src = TEST_JPEG;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    // Rotated upright, the image is 8×16, leaving (12, 4) empty; unrotated it is 16×8.
    return ctx.getImageData(12, 4, 1, 1).data[3] === 0;
  })().catch(() => true);
  return detected;
}

/** Maps stored pixel coordinates to upright coordinates for an EXIF orientation (1–8). */
export function orientationMatrix(orientation: number, w: number, h: number): DOMMatrix {
  const m: Record<number, [number, number, number, number, number, number]> = {
    2: [-1, 0, 0, 1, w, 0],
    3: [-1, 0, 0, -1, w, h],
    4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, h, 0],
    7: [0, -1, -1, 0, h, w],
    8: [0, -1, 1, 0, 0, w],
  };
  return new DOMMatrix(m[orientation] ?? [1, 0, 0, 1, 0, 0]);
}

export const swapsAxes = (orientation: number) => orientation >= 5 && orientation <= 8;
