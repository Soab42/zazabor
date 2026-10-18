import type { VideoSurface } from "./api";

/**
 * Placeholder surface: a plain black canvas that follows its box. The backend branch replaces
 * this file with the WebGL implementation; the signature stays.
 */
export function createVideoSurface(): VideoSurface {
  const el = document.createElement("canvas");
  el.style.cssText = "display:block;width:100%;height:100%;background:black";
  const pixelSize = { width: 0, height: 0 };
  const observer = new ResizeObserver(() => {
    const ratio = window.devicePixelRatio || 1;
    pixelSize.width = el.width = Math.max(1, Math.round(el.clientWidth * ratio));
    pixelSize.height = el.height = Math.max(1, Math.round(el.clientHeight * ratio));
  });
  observer.observe(el);
  return {
    el,
    start() {},
    stop() {},
    pixelSize,
    dispose() {
      observer.disconnect();
    },
  };
}
