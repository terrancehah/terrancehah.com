// ESM shim that lets chartjs-plugin-roughness patch the Chart.js instance the
// page already loads.
//
// The plugin imports `chart.js` and `chart.js/helpers` as bare specifiers, and
// its own jsDelivr bundle resolves them to chart.js@4.3.0 — a *second* copy of
// Chart.js. The plugin would then patch the prototypes of that copy while the
// app draws with the UMD build, so nothing would change and a second ~200KB of
// Chart.js would be downloaded for nothing.
//
// The import map in index.html points both specifiers here instead, and this
// re-exports the UMD global's pieces. One Chart.js instance, patched in place.
const C = window.Chart;
const H = (C && C.helpers) || {};

// --- what the plugin imports from 'chart.js' ---
export const registry = C.registry;
export const defaults = C.defaults;
export const BarElement = C.BarElement;
export const Filler = C.Filler;
export const Tooltip = C.Tooltip;
export const Chart = C;
export default C;

// --- what it imports from 'chart.js/helpers' ---
export const addRoundedRectPath = H.addRoundedRectPath;
export const toTRBL = H.toTRBL;
export const toTRBLCorners = H.toTRBLCorners;
export const _limitValue = H._limitValue;
export const isObject = H.isObject;
