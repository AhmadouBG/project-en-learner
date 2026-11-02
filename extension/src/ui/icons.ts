/**
 * Shared inline SVG icon builders (16x16).
 *
 * Built via document.createElementNS so they render as genuine DOM SVG nodes
 * rather than parsed or escaped text.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export const PLAY_ICON_PATH =
  "M4.25 3.06c0-.82.9-1.32 1.6-.88l6.5 4.06c.65.41.65 1.35 0 1.76l-6.5 4.06c-.7.44-1.6-.06-1.6-.88V3.06Z";

export const STOP_ICON_PATH =
  "M4.25 4.25c0-.55.45-1 1-1h5.5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1h-5.5c-.55 0-1-.45-1-1v-5.5Z";

export const REPEAT_ICON_PATH =
  "M11.71 3.04a.75.75 0 0 1 1.06 0l1.48 1.48a.75.75 0 0 1 0 1.06l-1.48 1.48a.75.75 0 0 1-1.06-1.06l.2-.2H5.63A2.13 2.13 0 0 0 3.5 7.93a.75.75 0 0 1-1.5 0A3.63 3.63 0 0 1 5.63 4.3h6.28l-.2-.2a.75.75 0 0 1 0-1.06Zm1.54 5.03a.75.75 0 0 1 .75.75 3.63 3.63 0 0 1-3.63 3.63H4.09l.2.2a.75.75 0 0 1-1.06 1.06l-1.48-1.48a.75.75 0 0 1 0-1.06l1.48-1.48a.75.75 0 1 1 1.06 1.06l-.2.2h6.28a2.13 2.13 0 0 0 2.13-2.13.75.75 0 0 1 .75-.75Z";

export const SPEAKER_ICON_PATH =
  "M9.5 2.5a.75.75 0 0 1 .75.75v9.5a.75.75 0 0 1-1.28.53L5.41 10.5H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h2.41l3.56-2.78a.75.75 0 0 1 .53-.22Zm3.25 2.75a.75.75 0 0 1 .95.46 4.75 4.75 0 0 1 0 4.58.75.75 0 0 1-1.38-.6 3.25 3.25 0 0 0 0-3.38.75.75 0 0 1 .43-1.06Z";

function baseSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "display:inline-block;vertical-align:-3px;";
  return svg;
}

export function makeSvgPathIcon(pathD: string): SVGSVGElement {
  const svg = baseSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", pathD);
  svg.appendChild(path);
  return svg;
}

/**
 * Record icon circle SVG:
 * <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.75" fill="currentColor"/></svg>
 */
export function makeSvgRecordIcon(): SVGSVGElement {
  const svg = baseSvg();
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "4.75");
  circle.setAttribute("fill", "currentColor");
  svg.appendChild(circle);
  return svg;
}

export const makeSvgPlayIcon = (): SVGSVGElement => makeSvgPathIcon(PLAY_ICON_PATH);
export const makeSvgStopIcon = (): SVGSVGElement => makeSvgPathIcon(STOP_ICON_PATH);
export const makeSvgRepeatIcon = (): SVGSVGElement => makeSvgPathIcon(REPEAT_ICON_PATH);
export const makeSvgSpeakerIcon = (): SVGSVGElement => makeSvgPathIcon(SPEAKER_ICON_PATH);
