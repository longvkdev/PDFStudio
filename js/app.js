/* ============================================================
 * PDF STUDIO — Complete Application Logic
 * Stack: PDF.js (render) + Fabric.js (edit) + pdf-lib (export)
 * ============================================================ */

'use strict';

// ── PDF.js worker ────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ============================================================
// STATE
// ============================================================
const S = {
  pdfJsDoc:     null,   // PDF.js document
  pdfBytes:     null,   // ArrayBuffer of original PDF
  fileName:     'document.pdf',
  currentPage:  1,
  totalPages:   0,
  zoom:         1.2,    // render scale (1 = 1 PDF pt → 1 px)
  tool:         'select',
  fabricCanvas: null,
  pageStates:   {},     // { pageNum: fabricJSON }
  undoStacks:   {},     // { pageNum: [jsonStr, ...] }
  redoStacks:   {},     // { pageNum: [jsonStr, ...] }
  isRestoring:  false,  // flag to block undo push during restore
  deletedPages: new Set(),
  opts: {
    color:          '#ef4444',
    fontSize:       22,
    fontFamily:     'Arial',
    lineWidth:      3,
    hlColor:        '#fef08a',
    hlOpacity:      0.45,
  },
};

// ============================================================
// DOM READY
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  setupUploadScreen();
  setupEditorControls();
  setupKeyboard();
});

// ============================================================
// UPLOAD SCREEN
// ============================================================
function setupUploadScreen() {
  const fileInput = document.getElementById('file-input');
  const btnUpload = document.getElementById('btn-upload');
  const dropZone  = document.getElementById('drop-zone');

  btnUpload.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) openPDF(file);
    fileInput.value = '';
  });

  // Drag & drop
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      openPDF(file);
    } else {
      toast('Please drop a valid PDF file', 'error');
    }
  });
  dropZone.addEventListener('click', () => fileInput.click());
}

// ============================================================
// OPEN / LOAD PDF
// ============================================================
async function openPDF(file) {
  showLoading('Loading PDF…');
  try {
    S.fileName    = file.name;
    S.pdfBytes    = await file.arrayBuffer();
    S.pageStates  = {};
    S.undoStacks  = {};
    S.redoStacks  = {};
    S.deletedPages = new Set();
    S.currentPage = 1;

    const typedArr  = new Uint8Array(S.pdfBytes.slice(0));
    S.pdfJsDoc      = await pdfjsLib.getDocument({ data: typedArr }).promise;
    S.totalPages    = S.pdfJsDoc.numPages;

    // Switch to editor view
    document.getElementById('upload-screen').classList.add('hidden');
    document.getElementById('editor-screen').classList.remove('hidden');

    // Update header meta
    document.getElementById('file-name-display').textContent = file.name;
    document.getElementById('page-count').textContent        = S.totalPages;
    document.getElementById('total-pages-badge').textContent = S.totalPages;

    // Init Fabric canvas
    initFabric();

    // Thumbnails (non-blocking)
    buildThumbnails();

    // Render first page
    await renderPage(1);

    // Auto-fit zoom
    autoFit();

  } catch (err) {
    console.error('openPDF error:', err);
    toast('Failed to load PDF: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// PAGE RENDERING
// ============================================================
async function renderPage(pageNum, skipSave = false) {
  if (pageNum < 1 || pageNum > S.totalPages) return;
  if (S.deletedPages.has(pageNum)) return;

  showLoading('Rendering…');

  // Save current page before switching
  if (!skipSave && S.fabricCanvas && pageNum !== S.currentPage) {
    savePageState(S.currentPage);
  }

  S.currentPage = pageNum;

  try {
    const page     = await S.pdfJsDoc.getPage(pageNum);
    const vp       = page.getViewport({ scale: S.zoom });

    // ── PDF canvas ──────────────────────────────────────────
    const pdfCvs   = document.getElementById('pdf-canvas');
    const ctx      = pdfCvs.getContext('2d');
    pdfCvs.width   = vp.width;
    pdfCvs.height  = vp.height;
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // ── Fabric canvas resize ────────────────────────────────
    const fc = S.fabricCanvas;
    S.isRestoring = true;
    fc.setWidth(vp.width);
    fc.setHeight(vp.height);

    // Apply viewport transform so fabric objects live in "PDF point space"
    fc.setViewportTransform([S.zoom, 0, 0, S.zoom, 0, 0]);

    // Update container CSS
    const container = document.getElementById('canvas-container');
    container.style.width  = vp.width  + 'px';
    container.style.height = vp.height + 'px';

    // Restore or clear Fabric state for this page
    const saved = S.pageStates[pageNum];
    if (saved) {
      await new Promise(r => fc.loadFromJSON(saved, r));
    } else {
      fc.clear();
    }
    fc.renderAll();
    S.isRestoring = false;

    // Init undo stack for fresh pages
    if (!S.undoStacks[pageNum]) {
      S.undoStacks[pageNum] = [JSON.stringify(fc.toJSON())];
      S.redoStacks[pageNum] = [];
    }

    updatePageNav();
    highlightThumb(pageNum);

  } catch (err) {
    console.error('renderPage error:', err);
    toast('Error rendering page', 'error');
    S.isRestoring = false;
  } finally {
    hideLoading();
  }
}

// Save current page Fabric state to S.pageStates
function savePageState(pageNum) {
  if (!S.fabricCanvas) return;
  S.pageStates[pageNum] = S.fabricCanvas.toJSON();
}

// ============================================================
// FABRIC CANVAS
// ============================================================
function initFabric() {
  if (S.fabricCanvas) {
    S.fabricCanvas.dispose();
    S.fabricCanvas = null;
  }

  const fc = new fabric.Canvas('fabric-canvas', {
    preserveObjectStacking: true,
    selection: true,
    backgroundColor: null,
    enableRetinaScaling: false,
  });

  // Global object styling
  fabric.Object.prototype.set({
    borderColor:         '#6366f1',
    cornerColor:         '#6366f1',
    cornerStyle:         'circle',
    cornerSize:          9,
    transparentCorners:  false,
    borderScaleFactor:   1.5,
    padding:             4,
  });

  S.fabricCanvas = fc;

  // ── Undo tracking ────────────────────────────────────────
  fc.on('object:added',    () => pushUndo());
  fc.on('object:modified', () => pushUndo());
  fc.on('object:removed',  () => pushUndo());

  // ── Mouse events for tools ───────────────────────────────
  setupMouseEvents(fc);
}

// ============================================================
// MOUSE EVENTS
// ============================================================
let _drawing    = false;
let _startX     = 0;
let _startY     = 0;
let _activeObj  = null;

function setupMouseEvents(fc) {

  fc.on('mouse:down', opt => {
    const ptr = fc.getPointer(opt.e);
    const tool = S.tool;

    if (tool === 'text') {
      const active = fc.getActiveObject();
      if (active && active.isEditing) {
        setTool('select');
        return;
      }
      if (opt.target) return;

      addText(ptr.x, ptr.y);
      return;
    }

    if (tool === 'eraser') {
      const target = fc.findTarget(opt.e);
      if (target) {
        fc.remove(target);
        fc.discardActiveObject();
        fc.renderAll();
      }
      return;
    }

    if (tool === 'highlight' || tool === 'rect') {
      _drawing = true;
      _startX  = ptr.x;
      _startY  = ptr.y;

      const isHL = (tool === 'highlight');
      _activeObj = new fabric.Rect({
        left:        _startX,
        top:         _startY,
        width:       1,
        height:      1,
        fill:        isHL ? hexToRgba(S.opts.hlColor, S.opts.hlOpacity) : 'transparent',
        stroke:      isHL ? null : S.opts.color,
        strokeWidth: isHL ? 0    : S.opts.lineWidth,
        rx:          isHL ? 3 : 0,
        ry:          isHL ? 3 : 0,
        selectable:  false,
        evented:     false,
      });
      fc.add(_activeObj);
    }

    if (tool === 'arrow') {
      _drawing = true;
      _startX  = ptr.x;
      _startY  = ptr.y;
    }
  });

  fc.on('mouse:move', opt => {
    if (!_drawing || !_activeObj) return;
    const ptr = fc.getPointer(opt.e);
    const x = Math.min(ptr.x, _startX);
    const y = Math.min(ptr.y, _startY);
    const w = Math.abs(ptr.x - _startX);
    const h = Math.abs(ptr.y - _startY);

    _activeObj.set({ left: x, top: y, width: w || 1, height: h || 1 });
    fc.renderAll();
  });

  fc.on('mouse:up', opt => {
    if (!_drawing) return;
    _drawing = false;

    if (_activeObj) {
      if (_activeObj.width < 4 && _activeObj.height < 4) {
        fc.remove(_activeObj);
      } else {
        _activeObj.set({ selectable: true, evented: true });
        fc.setActiveObject(_activeObj);
      }
      _activeObj = null;
      fc.renderAll();
    }

    if (S.tool === 'arrow') {
      const ptr = fc.getPointer(opt.e);
      const dx = ptr.x - _startX;
      const dy = ptr.y - _startY;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        addArrow(_startX, _startY, ptr.x, ptr.y);
      }
    }
  });
}

// ============================================================
// TOOL ACTIONS
// ============================================================
function addText(x, y) {
  const t = new fabric.IText('Type here', {
    left:       x,
    top:        y,
    fontSize:   S.opts.fontSize,
    fill:       S.opts.color,
    fontFamily: S.opts.fontFamily,
    editable:   true,
    selectable: true,
    padding:    4,
  });
  S.fabricCanvas.add(t);
  S.fabricCanvas.setActiveObject(t);
  t.enterEditing();
  t.selectAll();
  S.fabricCanvas.renderAll();
}

function addArrow(x1, y1, x2, y2) {
  const dx  = x2 - x1;
  const dy  = y2 - y1;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const sz  = Math.max(12, S.opts.lineWidth * 4);

  const line = new fabric.Line([x1, y1, x2, y2], {
    stroke:      S.opts.color,
    strokeWidth: S.opts.lineWidth,
    selectable:  false,
    evented:     false,
  });

  const head = new fabric.Triangle({
    left:      x2,
    top:       y2,
    width:     sz,
    height:    sz,
    fill:      S.opts.color,
    angle:     ang + 90,
    originX:   'center',
    originY:   'center',
    selectable: false,
    evented:    false,
  });

  const grp = new fabric.Group([line, head], { selectable: true, evented: true });
  S.fabricCanvas.add(grp);
  S.fabricCanvas.renderAll();
}

// ============================================================
// TOOL SWITCHING
// ============================================================
function setTool(tool) {
  S.tool = tool;
  const fc = S.fabricCanvas;
  if (!fc) return;

  fc.isDrawingMode = false;
  fc.selection     = false;
  fc.defaultCursor = 'crosshair';

  switch (tool) {
    case 'select':
      fc.selection     = true;
      fc.defaultCursor = 'default';
      break;
    case 'text':
      fc.defaultCursor = 'text';
      break;
    case 'draw':
      fc.isDrawingMode = true;
      fc.freeDrawingBrush.color   = S.opts.color;
      fc.freeDrawingBrush.width   = S.opts.lineWidth;
      fc.freeDrawingBrush.decimate = 3;
      break;
    case 'eraser':
      fc.defaultCursor = 'cell';
      break;
    case 'highlight':
    case 'rect':
    case 'arrow':
    default:
      fc.defaultCursor = 'crosshair';
  }

  // Toolbar highlight
  document.querySelectorAll('.tool-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === tool)
  );

  renderToolOptions(tool);
}

// ============================================================
// TOOL OPTIONS PANEL
// ============================================================
function renderToolOptions(tool) {
  const panel = document.getElementById('tool-options');
  panel.innerHTML = '';

  const addDivider = () => {
    const d = document.createElement('div');
    d.className = 'opt-divider';
    panel.appendChild(d);
  };

  // Color picker (all tools except select & eraser)
  if (['text', 'draw', 'rect', 'arrow'].includes(tool)) {
    const lbl = el('span', 'opt-label', 'Color:');
    const inp = document.createElement('input');
    inp.type  = 'color';
    inp.value = S.opts.color;
    inp.className = 'color-swatch';
    inp.title = 'Stroke / Text color';
    inp.addEventListener('input', e => {
      S.opts.color = e.target.value;
      if (S.fabricCanvas) {
        if (tool === 'draw') {
          S.fabricCanvas.freeDrawingBrush.color = S.opts.color;
        }
        const activeObj = S.fabricCanvas.getActiveObject();
        if (activeObj) {
          if (activeObj.type === 'i-text') activeObj.set('fill', S.opts.color);
          else if (['path', 'rect', 'line'].includes(activeObj.type)) activeObj.set('stroke', S.opts.color);
          S.fabricCanvas.renderAll();
        }
      }
    });
    panel.appendChild(lbl);
    panel.appendChild(inp);
  }

  // Highlight color presets
  if (tool === 'highlight') {
    const lbl = el('span', 'opt-label', 'Color:');
    panel.appendChild(lbl);
    const colors = ['#fef08a', '#bbf7d0', '#fecaca', '#bfdbfe', '#f5d0fe', '#fed7aa'];
    const wrap = el('div', 'hl-colors');
    colors.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'hl-color-btn' + (S.opts.hlColor === c ? ' active' : '');
      btn.style.background = c;
      btn.title = c;
      btn.addEventListener('click', () => {
        S.opts.hlColor = c;
        wrap.querySelectorAll('.hl-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      wrap.appendChild(btn);
    });
    panel.appendChild(wrap);

    addDivider();
    panel.appendChild(el('span', 'opt-label', 'Opacity:'));
    const slider = makeSlider(S.opts.hlOpacity * 100, 10, 90, '%', v => {
      S.opts.hlOpacity = v / 100;
    });
    panel.appendChild(slider);
  }

  // Font size (text)
  if (tool === 'text') {
    addDivider();
    panel.appendChild(el('span', 'opt-label', 'Size:'));
    const sizeInp = document.createElement('input');
    sizeInp.type  = 'number';
    sizeInp.min   = '8'; sizeInp.max = '120';
    sizeInp.value = S.opts.fontSize;
    sizeInp.className = 'opt-number';
    sizeInp.addEventListener('input', e => {
      const v = parseInt(e.target.value);
      if (!isNaN(v)) {
        S.opts.fontSize = Math.max(8, Math.min(120, v));
        if (S.fabricCanvas) {
          const activeObj = S.fabricCanvas.getActiveObject();
          if (activeObj && activeObj.type === 'i-text') {
            activeObj.set('fontSize', S.opts.fontSize);
            S.fabricCanvas.renderAll();
          }
        }
      }
    });
    sizeInp.addEventListener('blur', () => {
      sizeInp.value = S.opts.fontSize;
    });
    panel.appendChild(sizeInp);

    addDivider();
    panel.appendChild(el('span', 'opt-label', 'Font:'));
    const fontSel = document.createElement('select');
    fontSel.className = 'opt-select';
    ['Arial', 'Times New Roman', 'Georgia', 'Courier New', 'Helvetica', 'Verdana', 'Trebuchet MS'].forEach(f => {
      const o = document.createElement('option');
      o.value = f; o.textContent = f;
      if (f === S.opts.fontFamily) o.selected = true;
      fontSel.appendChild(o);
    });
    fontSel.addEventListener('change', e => { S.opts.fontFamily = e.target.value; });
    panel.appendChild(fontSel);
  }

  // Line width (draw, rect, arrow)
  if (['draw', 'rect', 'arrow'].includes(tool)) {
    addDivider();
    panel.appendChild(el('span', 'opt-label', 'Width:'));
    const slider = makeSlider(S.opts.lineWidth, 1, 20, 'px', v => {
      S.opts.lineWidth = v;
      if (tool === 'draw' && S.fabricCanvas) {
        S.fabricCanvas.freeDrawingBrush.width = v;
      }
    });
    panel.appendChild(slider);
  }
}

// Helper: create element
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text)      e.textContent = text;
  return e;
}

// Helper: create labeled slider
function makeSlider(initVal, min, max, unit, onChange) {
  const wrap = el('div', '');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

  const slider = document.createElement('input');
  slider.type  = 'range';
  slider.min   = min; slider.max = max; slider.value = initVal;
  slider.className = 'opt-slider';

  const lbl = el('span', 'opt-label', initVal + unit);
  lbl.style.minWidth = '36px';

  slider.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    lbl.textContent = v + unit;
    onChange(v);
  });

  wrap.appendChild(slider);
  wrap.appendChild(lbl);
  return wrap;
}

// ============================================================
// UNDO / REDO
// ============================================================
function pushUndo() {
  if (S.isRestoring) return;
  const p = S.currentPage;
  if (!S.undoStacks[p]) S.undoStacks[p] = [];
  if (!S.redoStacks[p]) S.redoStacks[p] = [];

  S.undoStacks[p].push(JSON.stringify(S.fabricCanvas.toJSON()));
  S.redoStacks[p] = [];

  if (S.undoStacks[p].length > 60) S.undoStacks[p].shift();
}

async function undo() {
  const p     = S.currentPage;
  const stack = S.undoStacks[p] || [];
  if (stack.length <= 1) { toast('Nothing to undo'); return; }

  const cur = stack.pop();
  (S.redoStacks[p] = S.redoStacks[p] || []).push(cur);

  const prev = stack[stack.length - 1];
  await restoreState(prev || '{"objects":[]}');
}

async function redo() {
  const p     = S.currentPage;
  const stack = S.redoStacks[p] || [];
  if (!stack.length) { toast('Nothing to redo'); return; }

  const next = stack.pop();
  (S.undoStacks[p] = S.undoStacks[p] || []).push(next);
  await restoreState(next);
}

async function restoreState(json) {
  S.isRestoring = true;
  await new Promise(r => S.fabricCanvas.loadFromJSON(json, () => {
    S.fabricCanvas.renderAll();
    r();
  }));
  S.isRestoring = false;
}

// ============================================================
// THUMBNAILS
// ============================================================
async function buildThumbnails() {
  const list = document.getElementById('pages-list');
  list.innerHTML = '';

  for (let i = 1; i <= S.totalPages; i++) {
    const item = createThumbEl(i);
    list.appendChild(item);
    // Async render
    renderThumb(i, item.querySelector('.thumb-canvas'));
  }
}

function createThumbEl(pageNum) {
  const item = document.createElement('div');
  item.className   = 'thumb-item';
  item.id          = `thumb-${pageNum}`;
  item.dataset.page = pageNum;

  const wrap = el('div', 'thumb-canvas-wrapper');
  const cvs  = document.createElement('canvas');
  cvs.className = 'thumb-canvas';
  wrap.appendChild(cvs);

  const delBtn = document.createElement('button');
  delBtn.className = 'thumb-delete-btn';
  delBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
  delBtn.title = 'Delete page';
  delBtn.onclick = e => { e.stopPropagation(); deletePage(pageNum); };
  wrap.appendChild(delBtn);

  const lbl = el('div', 'thumb-label', String(pageNum));

  item.appendChild(wrap);
  item.appendChild(lbl);
  item.addEventListener('click', () => renderPage(pageNum));

  return item;
}

async function renderThumb(pageNum, cvs) {
  try {
    const page = await S.pdfJsDoc.getPage(pageNum);
    const vp   = page.getViewport({ scale: 0.22 });
    cvs.width  = vp.width;
    cvs.height = vp.height;
    await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
  } catch { /* ignore individual thumb failures */ }
}

function highlightThumb(pageNum) {
  document.querySelectorAll('.thumb-item').forEach(t => t.classList.remove('active'));
  const active = document.getElementById(`thumb-${pageNum}`);
  if (active) {
    active.classList.add('active');
    active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ============================================================
// PAGE MANAGEMENT
// ============================================================
function deletePage(pageNum) {
  const remaining = S.totalPages - S.deletedPages.size;
  if (remaining <= 1) { toast('Cannot delete the last page', 'error'); return; }

  S.deletedPages.add(pageNum);
  delete S.pageStates[pageNum];

  const thumbEl = document.getElementById(`thumb-${pageNum}`);
  if (thumbEl) {
    thumbEl.classList.add('thumb-deleted');
    setTimeout(() => thumbEl.remove(), 300);
  }

  toast(`Page ${pageNum} deleted`);

  if (S.currentPage === pageNum) {
    // Navigate to nearest available page
    let next = pageNum + 1;
    while (next <= S.totalPages && S.deletedPages.has(next)) next++;
    if (next > S.totalPages) {
      next = pageNum - 1;
      while (next >= 1 && S.deletedPages.has(next)) next--;
    }
    if (next >= 1 && next <= S.totalPages) renderPage(next);
  }
}

// ============================================================
// ZOOM
// ============================================================
function changeZoom(delta) {
  const newZoom = parseFloat((S.zoom + delta).toFixed(2));
  if (newZoom < 0.3 || newZoom > 4.0) return;

  // Save Fabric state (objects are in PDF point space regardless of zoom)
  savePageState(S.currentPage);

  S.zoom = newZoom;
  updateZoomUI();

  // Re-render PDF at new scale; Fabric objects auto-adjust via viewport transform
  renderPage(S.currentPage, true);
}

function setZoomTo(z) {
  S.zoom = parseFloat(z.toFixed(2));
  savePageState(S.currentPage);
  updateZoomUI();
  renderPage(S.currentPage, true);
}

function updateZoomUI() {
  document.getElementById('zoom-level-text').textContent = Math.round(S.zoom * 100) + '%';
}

function autoFit() {
  const scroll = document.getElementById('canvas-scroll');
  const avail  = scroll.clientWidth - 64; // minus padding
  const pdfCvs = document.getElementById('pdf-canvas');
  if (!pdfCvs.width) return;

  const naturalW = pdfCvs.width / S.zoom; // PDF points
  const fitZoom  = parseFloat(Math.min(avail / naturalW, 1.8).toFixed(2));
  setZoomTo(fitZoom);
}

// ============================================================
// PAGE NAVIGATION UI
// ============================================================
function updatePageNav() {
  const inp = document.getElementById('page-input');
  inp.value = S.currentPage;
  inp.max   = S.totalPages;
  document.getElementById('page-count').textContent = S.totalPages;

  document.getElementById('btn-prev').disabled = isFirstAvailable(S.currentPage);
  document.getElementById('btn-next').disabled = isLastAvailable(S.currentPage);
}

function isFirstAvailable(p) {
  for (let i = p - 1; i >= 1; i--) {
    if (!S.deletedPages.has(i)) return false;
  }
  return true;
}
function isLastAvailable(p) {
  for (let i = p + 1; i <= S.totalPages; i++) {
    if (!S.deletedPages.has(i)) return false;
  }
  return true;
}

function prevPage() {
  let p = S.currentPage - 1;
  while (p >= 1 && S.deletedPages.has(p)) p--;
  if (p >= 1) renderPage(p);
}
function nextPage() {
  let p = S.currentPage + 1;
  while (p <= S.totalPages && S.deletedPages.has(p)) p++;
  if (p <= S.totalPages) renderPage(p);
}

// ============================================================
// EXPORT — Annotated PDF via pdf-lib
// ============================================================
async function exportPDF() {
  showLoading('Generating PDF…');
  const dlBtn = document.getElementById('btn-download');
  dlBtn.classList.add('loading');

  try {
    // Flush current page
    savePageState(S.currentPage);

    const { PDFDocument } = PDFLib;
    const srcBytes  = new Uint8Array(S.pdfBytes);
    const pdfDoc    = await PDFDocument.load(srcBytes);
    const srcPages  = pdfDoc.getPages();

    // Build a new PDF with deleted pages removed and annotations added
    const newPdf  = await PDFDocument.create();

    for (let i = 1; i <= S.totalPages; i++) {
      if (S.deletedPages.has(i)) continue;

      // Copy page from source
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [i - 1]);
      newPdf.addPage(copiedPage);

      // Check if this page has any fabric annotations
      const fabricState = S.pageStates[i];
      if (!fabricState || !fabricState.objects || fabricState.objects.length === 0) continue;

      // Render fabric annotations to a PNG
      const png = await fabricStateToPNG(i, fabricState);
      if (!png) continue;

      // Embed PNG into new PDF page
      const imgBytes   = dataUrlToBytes(png);
      const pdfImg     = await newPdf.embedPng(imgBytes);
      const { width: pw, height: ph } = copiedPage.getSize();

      copiedPage.drawImage(pdfImg, { x: 0, y: 0, width: pw, height: ph, opacity: 1 });
    }

    const finalBytes = await newPdf.save();
    downloadBytes(finalBytes, S.fileName.replace(/\.pdf$/i, '_edited.pdf'));
    toast('PDF downloaded! 🎉', 'success');

  } catch (err) {
    console.error('exportPDF error:', err);
    toast('Export failed: ' + err.message, 'error');
  } finally {
    hideLoading();
    dlBtn.classList.remove('loading');
  }
}

// Render a saved Fabric state to a PNG at higher resolution
async function fabricStateToPNG(pageNum, fabricState) {
  const exportScale = 3.0; // Tăng độ phân giải lên 3x để chữ không bị mờ
  const page = await S.pdfJsDoc.getPage(pageNum);
  const vp   = page.getViewport({ scale: exportScale });

  // Create hidden canvas
  const cvs = document.createElement('canvas');
  cvs.width  = vp.width;
  cvs.height = vp.height;
  cvs.style.display = 'none';
  document.body.appendChild(cvs);

  try {
    // fabric.StaticCanvas for off-screen rendering
    const fc = new fabric.StaticCanvas(cvs, {
      width:  vp.width,
      height: vp.height,
      enableRetinaScaling: false,
      backgroundColor: null,
    });

    await new Promise(r => fc.loadFromJSON(fabricState, r));
    fc.setWidth(vp.width);
    fc.setHeight(vp.height);
    // Objects are in PDF-point space; scale them up
    fc.setViewportTransform([exportScale, 0, 0, exportScale, 0, 0]);
    fc.renderAll();

    const png = cvs.toDataURL('image/png');
    fc.dispose();
    return png;

  } catch (err) {
    console.warn(`fabricStateToPNG error p${pageNum}:`, err);
    return null;
  } finally {
    document.body.removeChild(cvs);
  }
}

// data:image/png;base64,… → Uint8Array
function dataUrlToBytes(dataUrl) {
  const b64    = dataUrl.split(',')[1];
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ============================================================
// EDITOR CONTROLS — Wiring up all buttons
// ============================================================
function setupEditorControls() {

  // Back button
  document.getElementById('btn-back').addEventListener('click', () => {
    if (confirm('Go back? Unsaved annotations will be lost.')) {
      document.getElementById('editor-screen').classList.add('hidden');
      document.getElementById('upload-screen').classList.remove('hidden');
      if (S.fabricCanvas) { S.fabricCanvas.dispose(); S.fabricCanvas = null; }
    }
  });

  // Tool buttons
  document.querySelectorAll('[data-tool]').forEach(btn =>
    btn.addEventListener('click', () => setTool(btn.dataset.tool))
  );

  // Undo / Redo
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // Download
  document.getElementById('btn-download').addEventListener('click', exportPDF);

  // Zoom
  document.getElementById('btn-zoom-in') .addEventListener('click', () => changeZoom(+0.15));
  document.getElementById('btn-zoom-out').addEventListener('click', () => changeZoom(-0.15));
  document.getElementById('btn-zoom-fit').addEventListener('click', () => autoFit());

  // Page nav
  document.getElementById('btn-prev').addEventListener('click', prevPage);
  document.getElementById('btn-next').addEventListener('click', nextPage);

  const pageInput = document.getElementById('page-input');
  pageInput.addEventListener('change', () => {
    let p = parseInt(pageInput.value);
    if (isNaN(p) || p < 1) p = 1;
    if (p > S.totalPages) p = S.totalPages;
    renderPage(p);
  });
  pageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') pageInput.dispatchEvent(new Event('change'));
  });
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    // Don't intercept if typing in an input or fabric text editing
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (S.fabricCanvas && S.fabricCanvas.getActiveObject()?.isEditing) return;

    const ctrlOrCmd = e.ctrlKey || e.metaKey;

    if (ctrlOrCmd && e.key === 'z') { e.preventDefault(); undo(); return; }
    if (ctrlOrCmd && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }
    if (ctrlOrCmd && e.key === 's') { e.preventDefault(); exportPDF(); return; }

    if (!S.pdfJsDoc) return; // editor not open

    const keyTool = {
      'v': 'select', 't': 'text', 'h': 'highlight',
      'd': 'draw', 'r': 'rect', 'a': 'arrow', 'e': 'eraser',
    }[e.key.toLowerCase()];
    if (keyTool) { setTool(keyTool); return; }

    if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   { prevPage(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown')  { nextPage(); return; }
    if (e.key === '+' || e.key === '=') { changeZoom(+0.15); return; }
    if (e.key === '-')                  { changeZoom(-0.15); return; }
    if (e.key === '0')                  { autoFit(); return; }

    // Delete selected fabric object
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.fabricCanvas) {
      const obj = S.fabricCanvas.getActiveObject();
      if (obj) {
        S.fabricCanvas.remove(obj);
        S.fabricCanvas.discardActiveObject();
        S.fabricCanvas.renderAll();
      }
    }
  });
}

// ============================================================
// LOADING & TOAST
// ============================================================
function showLoading(msg = 'Loading…') {
  document.getElementById('loading-text').textContent = msg;
  document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

let _toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  const icon = type === 'error' ? '✕' : type === 'success' ? '✓' : 'ℹ';
  el.innerHTML = `<span>${icon}</span> ${msg}`;
  el.className = `toast${type ? ' ' + type : ''}`;
  el.classList.remove('hidden');

  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ============================================================
// HELPERS
// ============================================================
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
