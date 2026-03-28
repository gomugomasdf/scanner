/**
 * pc.js
 * PC side: session management, QR generation, Gun.js relay subscription,
 * state machine, correction pipeline orchestration.
 */

'use strict';

(async () => {

  // ─── State Machine ──────────────────────────────────────────────────────
  // States: waiting | receiving | corner | processing | done
  const STATES = ['waiting', 'receiving', 'corner', 'processing', 'done'];
  let currentState = 'waiting';

  function setState(state) {
    if (!STATES.includes(state)) return;
    currentState = state;
    STATES.forEach(s => {
      const el = document.getElementById(`state-${s}`);
      if (el) el.classList.toggle('active', s === state);
    });
    console.log('[PC] State:', state);
  }

  // ─── DOM Refs ───────────────────────────────────────────────────────────
  const $qrcode       = document.getElementById('qrcode');
  const $sessionIdTxt = document.getElementById('session-id-text');
  const $previewImg   = document.getElementById('preview-image');
  const $cornerCanvas = document.getElementById('corner-canvas');
  const $confirmBtn   = document.getElementById('confirm-corners-btn');
  const $resetBtn     = document.getElementById('reset-corners-btn');
  const $resultCanvas = document.getElementById('result-canvas');
  const $downloadBtn  = document.getElementById('download-btn');
  const $scanAgainBtn = document.getElementById('scan-again-btn');
  const $progressBar  = document.getElementById('progress-bar');
  const $progressLabel= document.getElementById('progress-label');
  const $toast        = document.getElementById('toast');

  // ─── Session ────────────────────────────────────────────────────────────
  let sessionId = null;
  let gun = null;
  let gunNode = null;
  let lastTs = 0;

  // Current image element used for processing
  let rawImageEl = null;
  // Detected corners (image space)
  let autoCorners = null;

  function generateSession() {
    sessionId = crypto.randomUUID();
    if ($sessionIdTxt) $sessionIdTxt.textContent = `세션: ${sessionId.slice(0, 8)}…`;
    return sessionId;
  }

  // ─── QR Code ────────────────────────────────────────────────────────────
  function generateQR(sessionId) {
    if (!$qrcode) return;
    $qrcode.innerHTML = '';

    const base = location.origin + location.pathname.replace(/\/?index\.html$/, '/').replace(/([^/])$/, '$1/');
    const url  = `${base}camera.html?session=${sessionId}`;

    console.log('[PC] QR URL:', url);

    const canvas = document.createElement('canvas');
    $qrcode.appendChild(canvas);

    QRCode.toCanvas(canvas, url, {
      width: 240,
      margin: 2,
      color: { dark: '#1a1a1a', light: '#ffffff' },
    }, err => {
      if (err) {
        console.error('[PC] QR generation error:', err);
        $qrcode.textContent = 'QR 생성 실패: ' + url;
      }
    });
  }

  // ─── Gun.js Setup ───────────────────────────────────────────────────────
  function setupGun(sessionId) {
    const peers = [
      'https://peer.wallie.io/gun',
      'https://gun-manhattan.herokuapp.com/gun',
    ];

    if (typeof Gun === 'undefined') {
      showToast('Gun.js 로드 실패. 네트워크를 확인하세요.');
      return;
    }

    gun = Gun({ peers, localStorage: false });
    gunNode = gun.get(sessionId);

    gunNode.on((data, key) => {
      if (!data || !data.image) return;
      if (!data.ts || data.ts <= lastTs) {
        console.log('[PC] Stale data, ignoring (ts:', data.ts, 'lastTs:', lastTs, ')');
        return;
      }
      if (currentState !== 'waiting' && currentState !== 'done') {
        console.log('[PC] Busy, ignoring incoming image');
        return;
      }
      lastTs = data.ts;
      console.log('[PC] Image received, ts:', data.ts, 'size ~', Math.round(data.image.length / 1024), 'KB');
      onImageReceived(data.image);
    });

    console.log('[PC] Gun subscribed to channel:', sessionId);
  }

  // ─── Image Received ─────────────────────────────────────────────────────
  function onImageReceived(dataUrl) {
    setState('receiving');

    const img = new Image();
    img.onload = () => {
      rawImageEl = img;
      // Show corner UI with auto-detected or default corners
      setupCornerUI(img);
    };
    img.onerror = () => {
      showToast('이미지 로드 실패. 다시 촬영해주세요.');
      setState('waiting');
    };
    img.src = dataUrl;
  }

  // ─── Corner UI Setup ────────────────────────────────────────────────────
  function setupCornerUI(img) {
    // Put image into the preview element
    $previewImg.onload = () => {
      setState('corner');

      // Try auto corner detection
      autoCorners = Correction.detectCorners(img);
      if (!autoCorners) {
        console.log('[PC] Auto corner detection failed, using defaults');
        showToast('코너 자동 감지 실패 — 직접 조정해주세요.');
      } else {
        showToast('코너가 자동 감지되었습니다. 필요시 조정하세요.');
      }

      // Initialize corner UI overlay
      CornerUI.init(
        $cornerCanvas,
        $previewImg,
        autoCorners,
        $confirmBtn,
        onCornersConfirmed
      );
    };
    $previewImg.src = img.src;
  }

  // ─── Corners Confirmed ──────────────────────────────────────────────────
  async function onCornersConfirmed(corners) {
    CornerUI.destroy();
    setState('processing');

    try {
      const resultCanvas = await Correction.runPipeline(
        rawImageEl,
        corners,
        (step, msg) => {
          const pct = Math.round((step / 3) * 100);
          if ($progressBar) $progressBar.style.width = pct + '%';
          if ($progressLabel) $progressLabel.textContent = msg;
        }
      );

      // Display result
      const ctx = $resultCanvas.getContext('2d');
      $resultCanvas.width  = resultCanvas.width;
      $resultCanvas.height = resultCanvas.height;
      ctx.drawImage(resultCanvas, 0, 0);

      setState('done');

      // Auto-download PDF
      Correction.generatePDF(resultCanvas, `scan-${Date.now()}.pdf`);

      // Store result canvas reference for manual re-download
      $resultCanvas._corrected = resultCanvas;

    } catch (err) {
      console.error('[PC] Pipeline error:', err);
      showToast('보정 처리 중 오류가 발생했습니다. 다시 시도하세요.');
      setState('corner');
      // Re-initialize corner UI
      CornerUI.init($cornerCanvas, $previewImg, autoCorners, $confirmBtn, onCornersConfirmed);
    }
  }

  // ─── Reset Corners ──────────────────────────────────────────────────────
  function onResetCorners() {
    CornerUI.destroy();
    CornerUI.init($cornerCanvas, $previewImg, null, $confirmBtn, onCornersConfirmed);
    showToast('코너가 기본값으로 초기화되었습니다.');
  }

  // ─── Scan Again ─────────────────────────────────────────────────────────
  function onScanAgain() {
    CornerUI.destroy();
    rawImageEl   = null;
    autoCorners  = null;
    $previewImg.src = '';
    if ($resultCanvas) { $resultCanvas.width = 0; $resultCanvas.height = 0; }
    if ($progressBar)  $progressBar.style.width = '0%';

    // New session to avoid stale data
    const newSession = generateSession();
    generateQR(newSession);
    setupGun(newSession);
    setState('waiting');
  }

  // ─── Download Button ────────────────────────────────────────────────────
  function onDownload() {
    const c = $resultCanvas._corrected || $resultCanvas;
    if (!c || c.width === 0) { showToast('다운로드할 이미지가 없습니다.'); return; }
    Correction.generatePDF(c, `scan-${Date.now()}.pdf`);
  }

  // ─── Toast ──────────────────────────────────────────────────────────────
  let _toastTimer = null;
  function showToast(msg, duration = 3000) {
    if (!$toast) return;
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => $toast.classList.remove('show'), duration);
  }

  // ─── Init ────────────────────────────────────────────────────────────────
  function init() {
    // Wire up buttons
    if ($confirmBtn)   $confirmBtn.addEventListener('click', () => {}); // handled by CornerUI
    if ($resetBtn)     $resetBtn.addEventListener('click', onResetCorners);
    if ($scanAgainBtn) $scanAgainBtn.addEventListener('click', onScanAgain);
    if ($downloadBtn)  $downloadBtn.addEventListener('click', onDownload);

    // Generate session and show QR
    const sid = generateSession();
    generateQR(sid);
    setupGun(sid);
    setState('waiting');
  }

  // Wait for all scripts to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
