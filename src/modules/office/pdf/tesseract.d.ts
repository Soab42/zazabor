/** tesseract.js's browser build (the package's main entry is its Node-flavoured source). */
declare module "tesseract.js/dist/tesseract.esm.min.js" {
  import type Tesseract from "tesseract.js";
  const T: typeof Tesseract;
  export default T;
}
