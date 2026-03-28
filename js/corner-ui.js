/**
 * corner-ui.js
 * Interactive corner adjustment overlay using a canvas on top of the preview image.
 * Supports both mouse and touch (pointer events).
 */

'use strict';

const CornerUI = (() => {

  const HANDLE_RADIUS = 22;
  const HANDLE_FILL   = 'rgba(33, 150, 243, 0.85)';
  const HANDLE_STROKE = '#fff';
  const LINE_COLOR    = 'rgba(33, 150, 243, 0.7)';
  const LINE_WIDTH    = 2.5;

  let _canvas = null;
  let _ctx    = null;
  let _image  = null;   // HTMLImageElement shown behind
  let _corners = [];    // [{x,y}] in image space, [TL, TR, BR, BL]
  let _displayScale = { sx: 1, sy: 1 }; // image display vs natural size
  let _dragging = null; // index of corner being dragged
  let _onConfirm = null;
  let _confirmBtn = null;

  // ─── Setup ─────────────────────────────────────────────────────────────

  /**
   * Initialize the corner UI.
   * @param {HTMLCanvasElement} canvas  The overlay canvas
   * @param {HTMLImageElement}  imgEl   The preview image element
   * @param {Array<{x,y}>|null} corners Initial corners in IMAGE coordinates, or null for default
   * @param {HTMLButtonElement} confirmBtn  Button that triggers confirm
   * @param {function} onConfirm  Called with (corners) when user confirms
   */
  function init(canvas, imgEl, corners, confirmBtn, onConfirm) {
    _canvas = canvas;
    _ctx    = canvas.getContext('2d');
    _image  = imgEl;
    _onConfirm = onConfirm;
    _confirmBtn = confirmBtn;

    _syncCanvasSize();

    if (corners && corners.length === 4) {
      _corners = corners.map(c => ({ ...c }));
    } else {
      _corners = _defaultCorners();
    }

    _render();
    _attachEvents();

    if (confirmBtn) {
      confirmBtn.addEventListener('click', _handleConfirm);
    }

    window.addEventListener('resize', _onResize);
  }

  function destroy() {
    _detachEvents();
    if (_confirmBtn) _confirmBtn.removeEventListener('click', _handleConfirm);
    window.removeEventListener('resize', _onResize);
    _canvas = null;
    _ctx = null;
    _image = null;
    _corners = [];
    _dragging = null;
    _onConfirm = null;
    _confirmBtn = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  function _syncCanvasSize() {
    const rect = _image.getBoundingClientRect();
    _canvas.width  = rect.width;
    _canvas.height = rect.height;
    _canvas.style.width  = rect.width  + 'px';
    _canvas.style.height = rect.height + 'px';

    _displayScale = {
      sx: rect.width  / (_image.naturalWidth  || rect.width),
      sy: rect.height / (_image.naturalHeight || rect.height),
    };
  }

  function _defaultCorners() {
    const imgW = _image.naturalWidth  || _canvas.width;
    const imgH = _image.naturalHeight || _canvas.height;
    const pad  = Math.round(Math.min(imgW, imgH) * 0.05);
    return [
      { x: pad,        y: pad },         // TL
      { x: imgW - pad, y: pad },         // TR
      { x: imgW - pad, y: imgH - pad },  // BR
      { x: pad,        y: imgH - pad },  // BL
    ];
  }

  // Convert image-space coords to canvas display coords
  function _toDisplay(pt) {
    return {
      x: pt.x * _displayScale.sx,
      y: pt.y * _displayScale.sy,
    };
  }

  // Convert canvas display coords to image-space coords
  function _toImage(pt) {
    return {
      x: pt.x / _displayScale.sx,
      y: pt.y / _displayScale.sy,
    };
  }

  function _render() {
    if (!_ctx) return;
    const w = _canvas.width;
    const h = _canvas.height;
    _ctx.clearRect(0, 0, w, h);

    const display = _corners.map(_toDisplay);

    // Draw quad fill (semi-transparent)
    _ctx.beginPath();
    _ctx.moveTo(display[0].x, display[0].y);
    for (let i = 1; i < 4; i++) _ctx.lineTo(display[i].x, display[i].y);
    _ctx.closePath();
    _ctx.fillStyle = 'rgba(33, 150, 243, 0.08)';
    _ctx.fill();

    // Draw quad outline
    _ctx.beginPath();
    _ctx.moveTo(display[0].x, display[0].y);
    for (let i = 1; i < 4; i++) _ctx.lineTo(display[i].x, display[i].y);
    _ctx.closePath();
    _ctx.strokeStyle = LINE_COLOR;
    _ctx.lineWidth   = LINE_WIDTH;
    _ctx.setLineDash([]);
    _ctx.stroke();

    // Draw handles
    const labels = ['TL', 'TR', 'BR', 'BL'];
    display.forEach((pt, i) => {
      _ctx.beginPath();
      _ctx.arc(pt.x, pt.y, HANDLE_RADIUS, 0, Math.PI * 2);
      _ctx.fillStyle   = i === _dragging ? 'rgba(33,150,243,1)' : HANDLE_FILL;
      _ctx.strokeStyle = HANDLE_STROKE;
      _ctx.lineWidth   = 3;
      _ctx.fill();
      _ctx.stroke();

      // Label
      _ctx.fillStyle  = '#fff';
      _ctx.font       = 'bold 11px sans-serif';
      _ctx.textAlign  = 'center';
      _ctx.textBaseline = 'middle';
      _ctx.fillText(labels[i], pt.x, pt.y);
    });
  }

  // ─── Event Handling ────────────────────────────────────────────────────

  function _getEventPos(e) {
    const rect = _canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: (touch.clientX - rect.left),
      y: (touch.clientY - rect.top),
    };
  }

  function _findHandle(pos) {
    const display = _corners.map(_toDisplay);
    for (let i = 0; i < display.length; i++) {
      const dx = display[i].x - pos.x;
      const dy = display[i].y - pos.y;
      if (Math.sqrt(dx*dx + dy*dy) <= HANDLE_RADIUS * 1.5) return i;
    }
    return -1;
  }

  function _onPointerDown(e) {
    e.preventDefault();
    const pos = _getEventPos(e);
    const idx = _findHandle(pos);
    if (idx >= 0) {
      _dragging = idx;
      _canvas.setPointerCapture && e.pointerId && _canvas.setPointerCapture(e.pointerId);
      _render();
    }
  }

  function _onPointerMove(e) {
    if (_dragging === null) return;
    e.preventDefault();
    const pos = _getEventPos(e);
    const imgPos = _toImage(pos);
    // Clamp to image bounds
    const imgW = _image.naturalWidth  || _canvas.width  / _displayScale.sx;
    const imgH = _image.naturalHeight || _canvas.height / _displayScale.sy;
    _corners[_dragging] = {
      x: Math.max(0, Math.min(imgW, imgPos.x)),
      y: Math.max(0, Math.min(imgH, imgPos.y)),
    };
    _render();
  }

  function _onPointerUp(e) {
    if (_dragging !== null) {
      _dragging = null;
      _render();
    }
  }

  function _attachEvents() {
    if (!_canvas) return;
    _canvas.addEventListener('pointerdown',  _onPointerDown,  { passive: false });
    _canvas.addEventListener('pointermove',  _onPointerMove,  { passive: false });
    _canvas.addEventListener('pointerup',    _onPointerUp);
    _canvas.addEventListener('pointercancel',_onPointerUp);
  }

  function _detachEvents() {
    if (!_canvas) return;
    _canvas.removeEventListener('pointerdown',  _onPointerDown);
    _canvas.removeEventListener('pointermove',  _onPointerMove);
    _canvas.removeEventListener('pointerup',    _onPointerUp);
    _canvas.removeEventListener('pointercancel',_onPointerUp);
  }

  function _onResize() {
    _syncCanvasSize();
    _render();
  }

  function _handleConfirm() {
    if (_onConfirm) _onConfirm([..._corners.map(c => ({ ...c }))]);
  }

  // ─── Public API ────────────────────────────────────────────────────────

  return { init, destroy };

})();
