/** EXIF orientations 5–8 rotate by a quarter turn, swapping width and height. */
export const swapsAxes = (orientation: number) => orientation >= 5 && orientation <= 8;
