/**
 * src/ui/airportEditor.ts — implements CreateAirportEditor: canvas
 * rendering + pointer-event interaction (pan/zoom, place/drag/rotate/
 * resize, toolbar). See docs/spec/11-ui.md section 4.5.
 */
import type {
  AirportEditorCallbacks,
  AirportEditorHandle,
  AirportEditorOptions,
  CreateAirportEditor,
  EditorApron,
  EditorAirportLayout,
  EditorPoint,
  EditorRunway,
  EditorRunwayIls,
  EditorTaxiway,
  EditorValidationIssue,
  OrientedRect,
} from '../contracts/ui';
import { ILS_DEFAULT_GLIDESLOPE_RAD } from '../contracts/core';
import { el, actionButton } from './domHelpers';
import { mountScreen } from './screenHandle';
import { runwayDesignator } from './airportEditorGeometry';
import { validateEditorLayout } from './airportEditorValidate';
import { exportEditorLayout, importEditorLayout, encodeLayoutToUrlHash } from './airportEditorExport';

const EDITOR_SNAP_OPTIONS_M = [0, 1, 5, 10] as const;
const DEFAULT_SNAP_INDEX = 1;
const HANDLE_HIT_RADIUS_PX = 10;
const TOUCH_HANDLE_HIT_RADIUS_PX = 18;
const MIN_PPM = 0.5;
const MAX_PPM = 20;
const DRAG_COMMIT_THRESHOLD_PX = 4;
const GRID_STEP_CANDIDATES_M = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const GRID_MIN_PX = 40;
const TERRAIN_PREVIEW_SAMPLE_SPACING_PX = 40;

function snappedM(v: number, snapM: number): number {
  return snapM === 0 ? v : Math.round(v / snapM) * snapM;
}

function forwardXZ(headingRad: number): EditorPoint {
  return { xM: Math.sin(headingRad), zM: -Math.cos(headingRad) };
}
function rightXZ(headingRad: number): EditorPoint {
  return { xM: Math.cos(headingRad), zM: Math.sin(headingRad) };
}
function wrap0to2pi(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

type RunwayEndKind = 'primary' | 'reciprocal';

type Selection =
  | { kind: 'none' }
  | { kind: 'runway'; id: string; end?: RunwayEndKind }
  | { kind: 'taxiway'; id: string; pointIndex?: number }
  | { kind: 'apron'; id: string; pointIndex?: number };

type EditorMode = 'select' | 'add-runway' | 'add-taxiway' | 'add-apron';

type DragKind =
  | { kind: 'pan' }
  | { kind: 'runway-center'; id: string }
  | { kind: 'runway-end'; id: string; end: RunwayEndKind }
  | { kind: 'runway-side'; id: string; side: 'A' | 'B' }
  | { kind: 'taxiway-point'; id: string; pointIndex: number }
  | { kind: 'apron-point'; id: string; pointIndex: number };

interface DragState {
  pointerId: number;
  kind: DragKind;
  startSx: number;
  startSy: number;
  lastSx: number;
  lastSy: number;
  moved: boolean;
  panStartPanXM: number;
  panStartPanZM: number;
}

function blankLayout(): EditorAirportLayout {
  return {
    id: 'new-airfield',
    name: 'New Airfield',
    referenceXM: 0,
    referenceZM: 0,
    elevationM: 0,
    runways: [],
    taxiways: [],
    aprons: [],
  };
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function toOrientedRect(r: EditorRunway): OrientedRect {
  return { centerXM: r.centerXM, centerZM: r.centerZM, headingRad: r.headingRad, halfLengthM: r.lengthM / 2, halfWidthM: r.widthM / 2 };
}

function pointInOrientedRect(px: number, pz: number, r: OrientedRect): boolean {
  const dx = px - r.centerXM;
  const dz = pz - r.centerZM;
  const fwd = forwardXZ(r.headingRad);
  const right = rightXZ(r.headingRad);
  const along = dx * fwd.xM + dz * fwd.zM;
  const across = dx * right.xM + dz * right.zM;
  return Math.abs(along) <= r.halfLengthM && Math.abs(across) <= r.halfWidthM;
}

function pointInPolygon(px: number, pz: number, points: readonly EditorPoint[]): boolean {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = points[i] as EditorPoint;
    const pj = points[j] as EditorPoint;
    const intersects = pi.zM > pz !== pj.zM > pz && px < ((pj.xM - pi.xM) * (pz - pi.zM)) / (pj.zM - pi.zM) + pi.xM;
    if (intersects) inside = !inside;
  }
  return inside;
}

function nextCounterFor(ids: readonly string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

export const createAirportEditor: CreateAirportEditor = (
  container: HTMLElement,
  options: AirportEditorOptions,
  callbacks: AirportEditorCallbacks
): AirportEditorHandle => {
  let layout: EditorAirportLayout = options.initial !== undefined ? deepClone(options.initial) : blankLayout();
  const sampler = options.sampler;

  let panXM = layout.referenceXM;
  let panZM = layout.referenceZM;
  let pixelsPerMeter = 2;
  let mode: EditorMode = 'select';
  let snapIndex = DEFAULT_SNAP_INDEX;
  let selection: Selection = { kind: 'none' };
  let draftPoints: EditorPoint[] = [];
  let deleteArmed = false;
  let ilsFormOpen = false;
  let drag: DragState | undefined;

  let runwayCounter = nextCounterFor(layout.runways.map((r) => r.id), 'runway-');
  let taxiwayCounter = nextCounterFor(layout.taxiways.map((t) => t.id), 'taxiway-');
  let apronCounter = nextCounterFor(layout.aprons.map((a) => a.id), 'apron-');

  // ---- DOM scaffold ----
  const root = el('div', { className: 'tj-airport-editor' });
  const toolbar = el('div', { className: 'tj-airport-editor-toolbar' });
  const canvasWrap = el('div', { className: 'tj-airport-editor-canvas-wrap' });
  const canvas = el('canvas', { className: 'tj-airport-editor-canvas' });
  canvasWrap.appendChild(canvas);
  const sidePanel = el('div', { className: 'tj-airport-editor-side-panel' });
  const issuesPanel = el('div', { className: 'tj-airport-editor-issues' });
  const ilsPanel = el('div', { className: 'tj-airport-editor-ils-form tj-hidden' });
  const ioPanel = el('div', { className: 'tj-airport-editor-io-panel tj-hidden' });
  const toast = el('div', { className: 'tj-airport-editor-toast tj-hidden' });

  sidePanel.append(issuesPanel, ilsPanel, ioPanel);
  root.append(toolbar, canvasWrap, sidePanel, toast);

  const selectBtn = actionButton('select', 'Select');
  const addRunwayBtn = actionButton('add-runway', 'Add Runway');
  const addTaxiwayBtn = actionButton('add-taxiway', 'Add Taxiway');
  const addApronBtn = actionButton('add-apron', 'Add Apron');
  const setIlsBtn = actionButton('set-ils', 'Set ILS');
  const removeIlsBtn = actionButton('remove-ils', 'Remove ILS');
  const deleteBtn = actionButton('delete', 'Delete');
  const finishShapeBtn = actionButton('finish-shape', 'Finish Shape');
  const cancelShapeBtn = actionButton('cancel-shape', 'Cancel Shape');
  const exportBtn = actionButton('export', 'Export');
  const importBtn = actionButton('import', 'Import');
  const copyLinkBtn = actionButton('copy-link', 'Copy Link');
  const testFlyBtn = actionButton('test-fly', 'Test Fly');
  const exitBtn = actionButton('exit', 'Exit');
  const snapBtn = actionButton('snap', '');

  toolbar.append(
    selectBtn,
    addRunwayBtn,
    addTaxiwayBtn,
    addApronBtn,
    setIlsBtn,
    removeIlsBtn,
    deleteBtn,
    finishShapeBtn,
    cancelShapeBtn,
    snapBtn,
    exportBtn,
    importBtn,
    copyLinkBtn,
    testFlyBtn,
    exitBtn
  );

  const exportOutput = el('textarea', { className: 'tj-airport-editor-export-output', attrs: { 'data-role': 'export-output', readonly: 'readonly' } }) as HTMLTextAreaElement;
  const importInput = el('textarea', { className: 'tj-airport-editor-import-input', attrs: { 'data-role': 'import-input' } }) as HTMLTextAreaElement;
  const importConfirmBtn = actionButton('import-confirm', 'Load');
  ioPanel.append(el('div', { text: 'Export JSON' }), exportOutput, el('div', { text: 'Import JSON' }), importInput, importConfirmBtn);

  const ilsFreqInput = el('input', { attrs: { type: 'number', step: '0.05', 'data-role': 'ils-freq' } }) as HTMLInputElement;
  const ilsGlideInput = el('input', { attrs: { type: 'number', step: '0.1', 'data-role': 'ils-glide-deg' } }) as HTMLInputElement;
  const ilsConfirmBtn = actionButton('ils-confirm', 'Confirm ILS');
  ilsPanel.append(
    el('label', { text: 'Frequency (MHz)' }),
    ilsFreqInput,
    el('label', { text: 'Glideslope (deg)' }),
    ilsGlideInput,
    ilsConfirmBtn
  );

  // ---- Coordinate transform ----
  function canvasSizePx(): { wPx: number; hPx: number } {
    const rect = canvas.getBoundingClientRect();
    const wPx = rect.width > 0 ? rect.width : canvas.width;
    const hPx = rect.height > 0 ? rect.height : canvas.height;
    return { wPx, hPx };
  }

  function worldToScreen(xM: number, zM: number): { sx: number; sy: number } {
    const { wPx, hPx } = canvasSizePx();
    return { sx: wPx / 2 + (xM - panXM) * pixelsPerMeter, sy: hPx / 2 + (zM - panZM) * pixelsPerMeter };
  }
  function screenToWorld(sx: number, sy: number): EditorPoint {
    const { wPx, hPx } = canvasSizePx();
    return { xM: panXM + (sx - wPx / 2) / pixelsPerMeter, zM: panZM + (sy - hPx / 2) / pixelsPerMeter };
  }

  // ---- Rendering ----
  function findRunway(id: string): EditorRunway | undefined {
    return layout.runways.find((r) => r.id === id);
  }
  function findTaxiway(id: string): EditorTaxiway | undefined {
    return layout.taxiways.find((t) => t.id === id);
  }
  function findApron(id: string): EditorApron | undefined {
    return layout.aprons.find((a) => a.id === id);
  }

  function drawGrid(ctx: CanvasRenderingContext2D, wPx: number, hPx: number): void {
    let g = GRID_STEP_CANDIDATES_M[GRID_STEP_CANDIDATES_M.length - 1] as number;
    for (const candidate of GRID_STEP_CANDIDATES_M) {
      if (candidate * pixelsPerMeter >= GRID_MIN_PX) {
        g = candidate;
        break;
      }
    }
    const worldLeft = screenToWorld(0, 0).xM;
    const worldRight = screenToWorld(wPx, 0).xM;
    const worldTop = screenToWorld(0, 0).zM;
    const worldBottom = screenToWorld(0, hPx).zM;

    const startXi = Math.floor(worldLeft / g);
    const endXi = Math.ceil(worldRight / g);
    const startZi = Math.floor(worldTop / g);
    const endZi = Math.ceil(worldBottom / g);

    for (let i = startXi; i <= endXi; i++) {
      const x = i * g;
      const major = i % 5 === 0;
      ctx.strokeStyle = major ? 'rgba(120,140,160,0.6)' : 'rgba(120,140,160,0.25)';
      ctx.lineWidth = 1;
      const s0 = worldToScreen(x, worldTop);
      const s1 = worldToScreen(x, worldBottom);
      ctx.beginPath();
      ctx.moveTo(s0.sx, s0.sy);
      ctx.lineTo(s1.sx, s1.sy);
      ctx.stroke();
    }
    for (let i = startZi; i <= endZi; i++) {
      const z = i * g;
      const major = i % 5 === 0;
      ctx.strokeStyle = major ? 'rgba(120,140,160,0.6)' : 'rgba(120,140,160,0.25)';
      ctx.lineWidth = 1;
      const s0 = worldToScreen(worldLeft, z);
      const s1 = worldToScreen(worldRight, z);
      ctx.beginPath();
      ctx.moveTo(s0.sx, s0.sy);
      ctx.lineTo(s1.sx, s1.sy);
      ctx.stroke();
    }
  }

  function drawTerrainPreview(ctx: CanvasRenderingContext2D, wPx: number, hPx: number): void {
    if (sampler === undefined) return;
    for (let sy = 0; sy < hPx; sy += TERRAIN_PREVIEW_SAMPLE_SPACING_PX) {
      for (let sx = 0; sx < wPx; sx += TERRAIN_PREVIEW_SAMPLE_SPACING_PX) {
        const w = screenToWorld(sx, sy);
        const h = sampler.heightAt(w.xM, w.zM);
        const shade = Math.max(0, Math.min(255, 60 + h * 0.5));
        ctx.fillStyle = `rgb(${shade * 0.3}, ${shade * 0.45}, ${shade * 0.3})`;
        ctx.fillRect(sx, sy, TERRAIN_PREVIEW_SAMPLE_SPACING_PX, TERRAIN_PREVIEW_SAMPLE_SPACING_PX);
      }
    }
  }

  function drawHandle(ctx: CanvasRenderingContext2D, sx: number, sy: number, selected: boolean): void {
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#ffd45e' : '#8fd3ff';
    ctx.fill();
    ctx.strokeStyle = '#0a0d12';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawRunway(ctx: CanvasRenderingContext2D, r: EditorRunway): void {
    const halfLen = r.lengthM / 2;
    const halfWid = r.widthM / 2;
    const fwd = forwardXZ(r.headingRad);
    const right = rightXZ(r.headingRad);
    const corners: EditorPoint[] = [
      { xM: r.centerXM + fwd.xM * halfLen + right.xM * halfWid, zM: r.centerZM + fwd.zM * halfLen + right.zM * halfWid },
      { xM: r.centerXM + fwd.xM * halfLen - right.xM * halfWid, zM: r.centerZM + fwd.zM * halfLen - right.zM * halfWid },
      { xM: r.centerXM - fwd.xM * halfLen - right.xM * halfWid, zM: r.centerZM - fwd.zM * halfLen - right.zM * halfWid },
      { xM: r.centerXM - fwd.xM * halfLen + right.xM * halfWid, zM: r.centerZM - fwd.zM * halfLen + right.zM * halfWid },
    ];
    const isSelected = selection.kind === 'runway' && selection.id === r.id;
    ctx.beginPath();
    corners.forEach((c, i) => {
      const s = worldToScreen(c.xM, c.zM);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    });
    ctx.closePath();
    ctx.fillStyle = isSelected ? 'rgba(255,212,94,0.25)' : 'rgba(180,180,190,0.18)';
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#ffd45e' : '#c9ccd1';
    ctx.lineWidth = 2;
    ctx.stroke();

    const endPrimary = { xM: r.centerXM + fwd.xM * halfLen, zM: r.centerZM + fwd.zM * halfLen };
    const endReciprocal = { xM: r.centerXM - fwd.xM * halfLen, zM: r.centerZM - fwd.zM * halfLen };
    const sideA = { xM: r.centerXM + right.xM * halfWid, zM: r.centerZM + right.zM * halfWid };
    const sideB = { xM: r.centerXM - right.xM * halfWid, zM: r.centerZM - right.zM * halfWid };
    const center = { xM: r.centerXM, zM: r.centerZM };

    const sp = worldToScreen(endPrimary.xM, endPrimary.zM);
    const sr = worldToScreen(endReciprocal.xM, endReciprocal.zM);
    const sa = worldToScreen(sideA.xM, sideA.zM);
    const sb = worldToScreen(sideB.xM, sideB.zM);
    const sc = worldToScreen(center.xM, center.zM);

    drawHandle(ctx, sp.sx, sp.sy, isSelected && selection.kind === 'runway' && selection.end === 'primary');
    drawHandle(ctx, sr.sx, sr.sy, isSelected && selection.kind === 'runway' && selection.end === 'reciprocal');
    drawHandle(ctx, sa.sx, sa.sy, false);
    drawHandle(ctx, sb.sx, sb.sy, false);
    drawHandle(ctx, sc.sx, sc.sy, false);

    ctx.fillStyle = '#e6e9ef';
    ctx.font = '11px sans-serif';
    ctx.fillText(runwayDesignator(r.headingRad), sp.sx + 6, sp.sy - 6);
    ctx.fillText(runwayDesignator(r.headingRad + Math.PI), sr.sx + 6, sr.sy - 6);
  }

  function drawTaxiway(ctx: CanvasRenderingContext2D, t: EditorTaxiway): void {
    const isSelected = selection.kind === 'taxiway' && selection.id === t.id;
    ctx.beginPath();
    t.points.forEach((p, i) => {
      const s = worldToScreen(p.xM, p.zM);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    });
    ctx.strokeStyle = isSelected ? '#ffd45e' : '#9aa0a8';
    ctx.lineWidth = Math.max(2, t.widthM * pixelsPerMeter);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
    t.points.forEach((p, i) => {
      const s = worldToScreen(p.xM, p.zM);
      drawHandle(ctx, s.sx, s.sy, isSelected && selection.kind === 'taxiway' && selection.pointIndex === i);
    });
  }

  function drawApron(ctx: CanvasRenderingContext2D, a: EditorApron): void {
    const isSelected = selection.kind === 'apron' && selection.id === a.id;
    ctx.beginPath();
    a.points.forEach((p, i) => {
      const s = worldToScreen(p.xM, p.zM);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    });
    ctx.closePath();
    ctx.fillStyle = isSelected ? 'rgba(255,212,94,0.2)' : 'rgba(120,150,120,0.25)';
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#ffd45e' : '#8fae8f';
    ctx.lineWidth = 2;
    ctx.stroke();
    a.points.forEach((p, i) => {
      const s = worldToScreen(p.xM, p.zM);
      drawHandle(ctx, s.sx, s.sy, isSelected && selection.kind === 'apron' && selection.pointIndex === i);
    });
  }

  function drawDraft(ctx: CanvasRenderingContext2D): void {
    if (draftPoints.length === 0) return;
    ctx.beginPath();
    draftPoints.forEach((p, i) => {
      const s = worldToScreen(p.xM, p.zM);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    });
    ctx.strokeStyle = '#ffd45e';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    draftPoints.forEach((p) => {
      const s = worldToScreen(p.xM, p.zM);
      drawHandle(ctx, s.sx, s.sy, true);
    });
  }

  function redraw(): void {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const { wPx, hPx } = canvasSizePx();
    if (canvas.width !== Math.round(wPx) || canvas.height !== Math.round(hPx)) {
      canvas.width = Math.max(1, Math.round(wPx));
      canvas.height = Math.max(1, Math.round(hPx));
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#141822';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawTerrainPreview(ctx, canvas.width, canvas.height);
    drawGrid(ctx, canvas.width, canvas.height);
    for (const a of layout.aprons) drawApron(ctx, a);
    for (const t of layout.taxiways) drawTaxiway(ctx, t);
    for (const r of layout.runways) drawRunway(ctx, r);
    drawDraft(ctx);

    updateToolbarState();
  }

  // ---- Validation + panel ----
  let lastIssues: readonly EditorValidationIssue[] = [];
  function revalidate(): void {
    lastIssues = validateEditorLayout(layout);
    issuesPanel.replaceChildren();
    const heading = el('div', { className: 'tj-airport-editor-issues-heading', text: `Validation (${lastIssues.length})` });
    issuesPanel.appendChild(heading);
    const list = el('ul', { className: 'tj-airport-editor-issues-list' });
    for (const issue of lastIssues) {
      list.appendChild(el('li', { className: `tj-issue-${issue.severity}`, text: `[${issue.severity}] ${issue.message}` }));
    }
    issuesPanel.appendChild(list);
  }

  function showToast(text: string): void {
    toast.textContent = text;
    toast.classList.remove('tj-hidden');
    setTimeout(() => toast.classList.add('tj-hidden'), 2500);
  }

  function commitChange(): void {
    revalidate();
    redraw();
    callbacks.onChange?.(getLayout());
  }

  // ---- Toolbar state ----
  function updateToolbarState(): void {
    selectBtn.classList.toggle('tj-active', mode === 'select');
    addRunwayBtn.classList.toggle('tj-active', mode === 'add-runway');
    addTaxiwayBtn.classList.toggle('tj-active', mode === 'add-taxiway');
    addApronBtn.classList.toggle('tj-active', mode === 'add-apron');

    const isRunwayEndSelected = selection.kind === 'runway' && selection.end !== undefined;
    setIlsBtn.disabled = !isRunwayEndSelected;
    let hasIls = false;
    if (isRunwayEndSelected && selection.kind === 'runway') {
      const r = findRunway(selection.id);
      if (r !== undefined) {
        hasIls = selection.end === 'primary' ? r.ilsPrimary !== undefined : r.ilsReciprocal !== undefined;
      }
    }
    removeIlsBtn.classList.toggle('tj-hidden', !(isRunwayEndSelected && hasIls));

    deleteBtn.disabled = selection.kind === 'none';
    deleteBtn.textContent = deleteArmed ? 'Confirm Delete' : 'Delete';

    const draftMin = mode === 'add-apron' ? 3 : 2;
    finishShapeBtn.classList.toggle('tj-hidden', mode !== 'add-taxiway' && mode !== 'add-apron');
    finishShapeBtn.disabled = draftPoints.length < draftMin;
    cancelShapeBtn.classList.toggle('tj-hidden', mode !== 'add-taxiway' && mode !== 'add-apron');

    snapBtn.textContent = `Snap: ${EDITOR_SNAP_OPTIONS_M[snapIndex]}m`;
  }

  function clearSelection(): void {
    selection = { kind: 'none' };
    deleteArmed = false;
    ilsFormOpen = false;
    ilsPanel.classList.add('tj-hidden');
  }

  // ---- Hit testing ----
  function hitRadiusFor(pointerType: string): number {
    return pointerType === 'touch' ? TOUCH_HANDLE_HIT_RADIUS_PX : HANDLE_HIT_RADIUS_PX;
  }

  interface HitResult {
    kind: DragKind | { kind: 'none' };
    selection: Selection;
  }

  function distPx(sx: number, sy: number, wx: number, wz: number): number {
    const s = worldToScreen(wx, wz);
    return Math.hypot(s.sx - sx, s.sy - sy);
  }

  function hitTest(sx: number, sy: number, pointerType: string): HitResult {
    const radius = hitRadiusFor(pointerType);

    for (const r of layout.runways) {
      const halfLen = r.lengthM / 2;
      const halfWid = r.widthM / 2;
      const fwd = forwardXZ(r.headingRad);
      const right = rightXZ(r.headingRad);
      const endPrimary = { xM: r.centerXM + fwd.xM * halfLen, zM: r.centerZM + fwd.zM * halfLen };
      const endReciprocal = { xM: r.centerXM - fwd.xM * halfLen, zM: r.centerZM - fwd.zM * halfLen };
      if (distPx(sx, sy, endPrimary.xM, endPrimary.zM) <= radius) {
        return { kind: { kind: 'runway-end', id: r.id, end: 'primary' }, selection: { kind: 'runway', id: r.id, end: 'primary' } };
      }
      if (distPx(sx, sy, endReciprocal.xM, endReciprocal.zM) <= radius) {
        return { kind: { kind: 'runway-end', id: r.id, end: 'reciprocal' }, selection: { kind: 'runway', id: r.id, end: 'reciprocal' } };
      }
    }
    for (const r of layout.runways) {
      const halfWid = r.widthM / 2;
      const right = rightXZ(r.headingRad);
      const sideA = { xM: r.centerXM + right.xM * halfWid, zM: r.centerZM + right.zM * halfWid };
      const sideB = { xM: r.centerXM - right.xM * halfWid, zM: r.centerZM - right.zM * halfWid };
      if (distPx(sx, sy, sideA.xM, sideA.zM) <= radius) {
        return { kind: { kind: 'runway-side', id: r.id, side: 'A' }, selection: { kind: 'runway', id: r.id } };
      }
      if (distPx(sx, sy, sideB.xM, sideB.zM) <= radius) {
        return { kind: { kind: 'runway-side', id: r.id, side: 'B' }, selection: { kind: 'runway', id: r.id } };
      }
    }
    for (const r of layout.runways) {
      if (distPx(sx, sy, r.centerXM, r.centerZM) <= radius) {
        return { kind: { kind: 'runway-center', id: r.id }, selection: { kind: 'runway', id: r.id } };
      }
    }

    // Point handles of the currently-selected taxiway/apron.
    if (selection.kind === 'taxiway') {
      const t = findTaxiway(selection.id);
      if (t !== undefined) {
        for (let i = 0; i < t.points.length; i++) {
          const p = t.points[i] as EditorPoint;
          if (distPx(sx, sy, p.xM, p.zM) <= radius) {
            return { kind: { kind: 'taxiway-point', id: t.id, pointIndex: i }, selection: { kind: 'taxiway', id: t.id, pointIndex: i } };
          }
        }
      }
    }
    if (selection.kind === 'apron') {
      const a = findApron(selection.id);
      if (a !== undefined) {
        for (let i = 0; i < a.points.length; i++) {
          const p = a.points[i] as EditorPoint;
          if (distPx(sx, sy, p.xM, p.zM) <= radius) {
            return { kind: { kind: 'apron-point', id: a.id, pointIndex: i }, selection: { kind: 'apron', id: a.id, pointIndex: i } };
          }
        }
      }
    }

    const w = screenToWorld(sx, sy);
    for (const r of layout.runways) {
      if (pointInOrientedRect(w.xM, w.zM, toOrientedRect(r))) {
        return { kind: { kind: 'none' }, selection: { kind: 'runway', id: r.id } };
      }
    }
    for (const a of layout.aprons) {
      if (a.points.length >= 3 && pointInPolygon(w.xM, w.zM, a.points)) {
        return { kind: { kind: 'none' }, selection: { kind: 'apron', id: a.id } };
      }
    }

    return { kind: { kind: 'none' }, selection: { kind: 'none' } };
  }

  // ---- Committed mutations ----
  function addRunwayAt(p: EditorPoint): void {
    const runway: EditorRunway = {
      id: `runway-${runwayCounter++}`,
      centerXM: snappedM(p.xM, EDITOR_SNAP_OPTIONS_M[snapIndex] as number),
      centerZM: snappedM(p.zM, EDITOR_SNAP_OPTIONS_M[snapIndex] as number),
      headingRad: 0,
      lengthM: 2500,
      widthM: 45,
      elevationM: layout.elevationM,
    };
    layout = { ...layout, runways: [...layout.runways, runway] };
    selection = { kind: 'runway', id: runway.id };
    mode = 'select';
    commitChange();
  }

  function finishDraftShape(): void {
    const snap = EDITOR_SNAP_OPTIONS_M[snapIndex] as number;
    if (mode === 'add-taxiway' && draftPoints.length >= 2) {
      const taxiway: EditorTaxiway = { id: `taxiway-${taxiwayCounter++}`, widthM: 20, points: draftPoints.map((p) => ({ xM: snappedM(p.xM, snap), zM: snappedM(p.zM, snap) })) };
      layout = { ...layout, taxiways: [...layout.taxiways, taxiway] };
      selection = { kind: 'taxiway', id: taxiway.id };
    } else if (mode === 'add-apron' && draftPoints.length >= 3) {
      const apron: EditorApron = {
        id: `apron-${apronCounter++}`,
        elevationM: layout.elevationM,
        points: draftPoints.map((p) => ({ xM: snappedM(p.xM, snap), zM: snappedM(p.zM, snap) })),
      };
      layout = { ...layout, aprons: [...layout.aprons, apron] };
      selection = { kind: 'apron', id: apron.id };
    } else {
      return;
    }
    draftPoints = [];
    mode = 'select';
    commitChange();
  }

  function cancelDraftShape(): void {
    draftPoints = [];
    mode = 'select';
    redraw();
  }

  function deleteSelected(): void {
    if (selection.kind === 'runway') {
      const sel = selection;
      layout = { ...layout, runways: layout.runways.filter((r) => r.id !== sel.id) };
    } else if (selection.kind === 'taxiway') {
      const sel = selection;
      const t = findTaxiway(sel.id);
      if (t !== undefined && sel.pointIndex !== undefined && t.points.length > 2) {
        const points = t.points.filter((_, i) => i !== sel.pointIndex);
        layout = { ...layout, taxiways: layout.taxiways.map((x) => (x.id === sel.id ? { ...x, points } : x)) };
      } else {
        layout = { ...layout, taxiways: layout.taxiways.filter((x) => x.id !== sel.id) };
      }
    } else if (selection.kind === 'apron') {
      const sel = selection;
      const a = findApron(sel.id);
      if (a !== undefined && sel.pointIndex !== undefined && a.points.length > 3) {
        const points = a.points.filter((_, i) => i !== sel.pointIndex);
        layout = { ...layout, aprons: layout.aprons.map((x) => (x.id === sel.id ? { ...x, points } : x)) };
      } else {
        layout = { ...layout, aprons: layout.aprons.filter((x) => x.id !== sel.id) };
      }
    }
    clearSelection();
    commitChange();
  }

  // ---- Pointer interaction ----
  function onPointerDown(ev: PointerEvent): void {
    canvas.setPointerCapture(ev.pointerId);
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;

    if (mode === 'add-runway' || mode === 'add-taxiway' || mode === 'add-apron') {
      drag = { pointerId: ev.pointerId, kind: { kind: 'pan' }, startSx: sx, startSy: sy, lastSx: sx, lastSy: sy, moved: false, panStartPanXM: panXM, panStartPanZM: panZM };
      return;
    }

    const hit = hitTest(sx, sy, ev.pointerType);
    selection = hit.selection;
    deleteArmed = false;
    if (hit.kind.kind === 'none') {
      drag = { pointerId: ev.pointerId, kind: { kind: 'pan' }, startSx: sx, startSy: sy, lastSx: sx, lastSy: sy, moved: false, panStartPanXM: panXM, panStartPanZM: panZM };
    } else {
      drag = { pointerId: ev.pointerId, kind: hit.kind, startSx: sx, startSy: sy, lastSx: sx, lastSy: sy, moved: false, panStartPanXM: panXM, panStartPanZM: panZM };
    }
    redraw();
  }

  function onPointerMove(ev: PointerEvent): void {
    if (drag === undefined || drag.pointerId !== ev.pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    if (Math.hypot(sx - drag.startSx, sy - drag.startSy) > DRAG_COMMIT_THRESHOLD_PX) drag.moved = true;
    const snap = EDITOR_SNAP_OPTIONS_M[snapIndex] as number;

    if (drag.kind.kind === 'pan') {
      panXM -= (sx - drag.lastSx) / pixelsPerMeter;
      panZM -= (sy - drag.lastSy) / pixelsPerMeter;
    } else if (drag.kind.kind === 'runway-center') {
      const r = findRunway(drag.kind.id);
      if (r !== undefined) {
        const w = screenToWorld(sx, sy);
        r.centerXM = snappedM(w.xM, snap);
        r.centerZM = snappedM(w.zM, snap);
      }
    } else if (drag.kind.kind === 'runway-end') {
      const r = findRunway(drag.kind.id);
      if (r !== undefined) {
        const halfLen = r.lengthM / 2;
        const fwd = forwardXZ(r.headingRad);
        const fixed =
          drag.kind.end === 'primary'
            ? { xM: r.centerXM - fwd.xM * halfLen, zM: r.centerZM - fwd.zM * halfLen }
            : { xM: r.centerXM + fwd.xM * halfLen, zM: r.centerZM + fwd.zM * halfLen };
        const w = screenToWorld(sx, sy);
        const snapped = { xM: snappedM(w.xM, snap), zM: snappedM(w.zM, snap) };
        const rawX = snapped.xM - fixed.xM;
        const rawZ = snapped.zM - fixed.zM;
        const rawLen = Math.hypot(rawX, rawZ);
        if (rawLen > 1e-6) {
          const newLength = Math.max(500, Math.min(5000, rawLen));
          const dirX = rawX / rawLen;
          const dirZ = rawZ / rawLen;
          const sign = drag.kind.end === 'primary' ? 1 : -1;
          r.centerXM = fixed.xM + sign * dirX * (newLength / 2);
          r.centerZM = fixed.zM + sign * dirZ * (newLength / 2);
          r.headingRad = wrap0to2pi(Math.atan2(sign * dirX, -sign * dirZ));
          r.lengthM = newLength;
        }
      }
    } else if (drag.kind.kind === 'runway-side') {
      const r = findRunway(drag.kind.id);
      if (r !== undefined) {
        const right = rightXZ(r.headingRad);
        const w = screenToWorld(sx, sy);
        const dx = w.xM - r.centerXM;
        const dz = w.zM - r.centerZM;
        const halfWid = Math.max(10, Math.min(40, dx * right.xM + dz * right.zM));
        r.widthM = snappedM(2 * Math.abs(halfWid), snap);
      }
    } else if (drag.kind.kind === 'taxiway-point') {
      const t = findTaxiway(drag.kind.id);
      if (t !== undefined) {
        const w = screenToWorld(sx, sy);
        const pt = t.points[drag.kind.pointIndex];
        if (pt !== undefined) {
          (pt as { xM: number; zM: number }).xM = snappedM(w.xM, snap);
          (pt as { xM: number; zM: number }).zM = snappedM(w.zM, snap);
        }
      }
    } else if (drag.kind.kind === 'apron-point') {
      const a = findApron(drag.kind.id);
      if (a !== undefined) {
        const w = screenToWorld(sx, sy);
        const pt = a.points[drag.kind.pointIndex];
        if (pt !== undefined) {
          (pt as { xM: number; zM: number }).xM = snappedM(w.xM, snap);
          (pt as { xM: number; zM: number }).zM = snappedM(w.zM, snap);
        }
      }
    }

    drag.lastSx = sx;
    drag.lastSy = sy;
    redraw();
  }

  function onPointerUp(ev: PointerEvent): void {
    if (drag === undefined || drag.pointerId !== ev.pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const wasDrag = drag.moved;
    const wasPan = drag.kind.kind === 'pan';
    canvas.releasePointerCapture(ev.pointerId);

    if (mode === 'add-runway' && !wasDrag) {
      addRunwayAt(screenToWorld(sx, sy));
    } else if ((mode === 'add-taxiway' || mode === 'add-apron') && !wasDrag) {
      const snap = EDITOR_SNAP_OPTIONS_M[snapIndex] as number;
      const w = screenToWorld(sx, sy);
      draftPoints = [...draftPoints, { xM: snappedM(w.xM, snap), zM: snappedM(w.zM, snap) }];
      redraw();
    } else if (mode === 'select' && !wasPan && wasDrag) {
      commitChange();
    } else if (mode === 'select') {
      redraw();
    }

    drag = undefined;
  }

  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    pixelsPerMeter = Math.max(MIN_PPM, Math.min(MAX_PPM, pixelsPerMeter * Math.pow(1.1, -ev.deltaY / 100)));
    const { wPx, hPx } = canvasSizePx();
    panXM = before.xM - (sx - wPx / 2) / pixelsPerMeter;
    panZM = before.zM - (sy - hPx / 2) / pixelsPerMeter;
    redraw();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      if (draftPoints.length > 0) cancelDraftShape();
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);

  // ---- Toolbar wiring ----
  selectBtn.addEventListener('click', () => {
    mode = 'select';
    draftPoints = [];
    redraw();
  });
  addRunwayBtn.addEventListener('click', () => {
    mode = 'add-runway';
    draftPoints = [];
    clearSelection();
    redraw();
  });
  addTaxiwayBtn.addEventListener('click', () => {
    mode = 'add-taxiway';
    draftPoints = [];
    clearSelection();
    redraw();
  });
  addApronBtn.addEventListener('click', () => {
    mode = 'add-apron';
    draftPoints = [];
    clearSelection();
    redraw();
  });
  finishShapeBtn.addEventListener('click', () => finishDraftShape());
  cancelShapeBtn.addEventListener('click', () => cancelDraftShape());

  deleteBtn.addEventListener('click', () => {
    if (selection.kind === 'none') return;
    if (!deleteArmed) {
      deleteArmed = true;
      redraw();
      return;
    }
    deleteSelected();
  });

  setIlsBtn.addEventListener('click', () => {
    if (selection.kind !== 'runway' || selection.end === undefined) return;
    const r = findRunway(selection.id);
    if (r === undefined) return;
    const existing = selection.end === 'primary' ? r.ilsPrimary : r.ilsReciprocal;
    ilsFreqInput.value = String(existing?.frequencyMhz ?? 110.3);
    ilsGlideInput.value = String(((existing?.glideslopeAngleRad ?? ILS_DEFAULT_GLIDESLOPE_RAD) * 180) / Math.PI);
    ilsFormOpen = true;
    ilsPanel.classList.remove('tj-hidden');
  });
  removeIlsBtn.addEventListener('click', () => {
    if (selection.kind !== 'runway' || selection.end === undefined) return;
    const sel = selection;
    layout = {
      ...layout,
      runways: layout.runways.map((r) => {
        if (r.id !== sel.id) return r;
        const next = { ...r };
        if (sel.end === 'primary') delete next.ilsPrimary;
        else delete next.ilsReciprocal;
        return next;
      }),
    };
    commitChange();
  });
  ilsConfirmBtn.addEventListener('click', () => {
    if (selection.kind !== 'runway' || selection.end === undefined) return;
    const sel = selection;
    const freq = Number(ilsFreqInput.value);
    const glideDeg = Number(ilsGlideInput.value);
    if (!Number.isFinite(freq) || !Number.isFinite(glideDeg)) return;
    const ils: EditorRunwayIls = { frequencyMhz: freq, glideslopeAngleRad: (glideDeg * Math.PI) / 180 };
    layout = {
      ...layout,
      runways: layout.runways.map((r) => {
        if (r.id !== sel.id) return r;
        return sel.end === 'primary' ? { ...r, ilsPrimary: ils } : { ...r, ilsReciprocal: ils };
      }),
    };
    ilsFormOpen = false;
    ilsPanel.classList.add('tj-hidden');
    commitChange();
  });

  exportBtn.addEventListener('click', () => {
    exportOutput.value = exportEditorLayout(layout);
    ioPanel.classList.remove('tj-hidden');
  });
  importBtn.addEventListener('click', () => {
    ioPanel.classList.remove('tj-hidden');
    importInput.focus();
  });
  importConfirmBtn.addEventListener('click', () => {
    const result = importEditorLayout(importInput.value);
    if (!result.ok) {
      showToast(`Import failed: ${result.error}`);
      return;
    }
    layout = result.value;
    clearSelection();
    runwayCounter = nextCounterFor(layout.runways.map((r) => r.id), 'runway-');
    taxiwayCounter = nextCounterFor(layout.taxiways.map((t) => t.id), 'taxiway-');
    apronCounter = nextCounterFor(layout.aprons.map((a) => a.id), 'apron-');
    commitChange();
  });
  copyLinkBtn.addEventListener('click', () => {
    const link = `${location.origin}${location.pathname}#edit=${encodeLayoutToUrlHash(getLayout())}`;
    navigator.clipboard.writeText(link).then(
      () => showToast('Link copied'),
      () => showToast('Copy failed')
    );
  });
  testFlyBtn.addEventListener('click', () => callbacks.onLaunchMission(getLayout()));
  exitBtn.addEventListener('click', () => callbacks.onExit());
  snapBtn.addEventListener('click', () => {
    snapIndex = (snapIndex + 1) % EDITOR_SNAP_OPTIONS_M.length;
    updateToolbarState();
  });

  function getLayout(): EditorAirportLayout {
    return deepClone(layout);
  }

  const baseHandle = mountScreen(container, root);
  revalidate();
  redraw();

  return {
    ...baseHandle,
    getLayout,
    setLayout(next: EditorAirportLayout): void {
      layout = deepClone(next);
      clearSelection();
      draftPoints = [];
      mode = 'select';
      runwayCounter = nextCounterFor(layout.runways.map((r) => r.id), 'runway-');
      taxiwayCounter = nextCounterFor(layout.taxiways.map((t) => t.id), 'taxiway-');
      apronCounter = nextCounterFor(layout.aprons.map((a) => a.id), 'apron-');
      revalidate();
      redraw();
    },
    getValidationIssues(): readonly EditorValidationIssue[] {
      return validateEditorLayout(layout);
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      baseHandle.destroy();
    },
  };
};
