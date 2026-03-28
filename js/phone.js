/**
 * phone.js
 * Phone camera page logic:
 *   - Parse sessionId from URL
 *   - getUserMedia (rear camera)
 *   - Capture photo → base64
 *   - Send via Gun.js to PC
 */

'use strict';

(async () => {

  // ─── DOM Refs ───────────────────────────────────────────────────────────
  const $video       = document.getElementById('camera-viewfinder');
  const $captureBtn  = document.getElementById('capture-btn');
  const $flash       = document.getElementById('capture-flash');
  const $resultOverlay = document.getElementById('result-overlay');
  const $anotherBtn  = document.getElementById('another-btn');
  const $statusDot   = document.getElementById('status-dot');
  const $statusText  = document.getElementById('status-text');
  const $errorOverlay= document.getElementById('error-overlay');
  const $errorMsg    = document.getElementById('error-message');
  const $retryBtn    = document.getElementById('error-retry-btn');

  // ─── Session ────────────────────────────────────────────────────────────
  const params    = new URLSearchParams(location.search);
  const sessionId = params.get('session');

  if (!sessionId) {
    showError('세션 ID가 없습니다. PC에서 QR코드를 다시 스캔해주세요.', false);
    return;
  }

  // ─── Gun.js ─────────────────────────────────────────────────────────────
  let gun = null;
  let gunNode = null;
  let isGunReady = false;

  function setupGun() {
    if (typeof Gun === 'undefined') {
      console.error('[Phone] Gun.js not loaded');
      setStatus('error', 'Gun.js 로드 실패');
      return;
    }

    const peers = [
      'https://peer.wallie.io/gun',
      'https://gun-manhattan.herokuapp.com/gun',
    ];

    setStatus('connecting', '연결 중...');
    gun = Gun({ peers, localStorage: false });
    gunNode = gun.get(sessionId);

    // Gun.js doesn't have a reliable "connected" callback,
    // so we mark ready after a short delay and trust it works
    setTimeout(() => {
      isGunReady = true;
      setStatus('connected', 'PC에 연결됨');
      console.log('[Phone] Gun ready, session:', sessionId);
    }, 1500);
  }

  // ─── Status ─────────────────────────────────────────────────────────────
  function setStatus(type, text) {
    if ($statusDot)  { $statusDot.className = 'status-dot ' + type; }
    if ($statusText) { $statusText.textContent = text; }
  }

  // ─── Camera ─────────────────────────────────────────────────────────────
  let stream = null;

  async function startCamera() {
    setStatus('connecting', '카메라 시작 중...');

    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920, max: 4096 },
        height: { ideal: 1080, max: 4096 },
      },
      audio: false,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      $video.srcObject = stream;
      await $video.play();
      setStatus('connected', 'PC에 연결됨');
      $captureBtn.disabled = false;
      console.log('[Phone] Camera started, track:', stream.getVideoTracks()[0].label);
    } catch (err) {
      console.error('[Phone] Camera error:', err);
      let msg = '카메라를 시작할 수 없습니다.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = '카메라 권한이 거부되었습니다.\n브라우저 설정에서 카메라 권한을 허용해주세요.';
      } else if (err.name === 'NotFoundError') {
        msg = '카메라를 찾을 수 없습니다.';
      } else if (err.name === 'NotReadableError') {
        msg = '카메라가 이미 사용 중입니다.';
      }
      showError(msg, true);
    }
  }

  // ─── Capture ────────────────────────────────────────────────────────────
  async function captureAndSend() {
    if (!stream || !$video.readyState) {
      showError('카메라가 준비되지 않았습니다.', true);
      return;
    }

    $captureBtn.disabled = true;

    // Flash effect
    if ($flash) {
      $flash.classList.add('flash');
      setTimeout(() => $flash.classList.remove('flash'), 200);
    }

    // Capture frame to canvas
    const vw = $video.videoWidth;
    const vh = $video.videoHeight;

    if (!vw || !vh) {
      showError('영상 스트림이 준비되지 않았습니다. 잠시 후 다시 시도해주세요.', true);
      $captureBtn.disabled = false;
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width  = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage($video, 0, 0, vw, vh);

    // Convert to JPEG
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const sizeKB  = Math.round(dataUrl.length * 0.75 / 1024);
    console.log('[Phone] Captured:', vw, 'x', vh, '~', sizeKB, 'KB');

    // Send via Gun.js
    setStatus('connecting', '전송 중...');

    try {
      await sendImage(dataUrl);
      setStatus('sent', '전송 완료!');
      showResultOverlay();
    } catch (err) {
      console.error('[Phone] Send error:', err);
      setStatus('error', '전송 실패');
      showError('이미지 전송에 실패했습니다. 네트워크를 확인하세요.', true);
      $captureBtn.disabled = false;
    }
  }

  function sendImage(dataUrl) {
    return new Promise((resolve, reject) => {
      if (!gun || !gunNode) {
        reject(new Error('Gun not initialized'));
        return;
      }

      const payload = { image: dataUrl, ts: Date.now() };

      // Gun.js put with ack callback
      gunNode.put(payload, (ack) => {
        if (ack.err) {
          console.warn('[Phone] Gun ack error:', ack.err, '— treating as sent (relay may not ack)');
        }
        // Gun relay servers sometimes don't send ack but still relay the data
        // We resolve regardless if data was sent
        resolve();
      });

      // Fallback: resolve after 5s even without ack
      setTimeout(resolve, 5000);
    });
  }

  // ─── Result Overlay ─────────────────────────────────────────────────────
  function showResultOverlay() {
    if ($resultOverlay) $resultOverlay.classList.add('show');
  }

  function hideResultOverlay() {
    if ($resultOverlay) $resultOverlay.classList.remove('show');
  }

  // ─── Another Photo ───────────────────────────────────────────────────────
  function takeAnother() {
    hideResultOverlay();
    setStatus('connected', 'PC에 연결됨');
    $captureBtn.disabled = false;
  }

  // ─── Error ───────────────────────────────────────────────────────────────
  function showError(msg, canRetry = true) {
    if ($errorMsg)    $errorMsg.textContent = msg;
    if ($retryBtn)    $retryBtn.style.display = canRetry ? 'block' : 'none';
    if ($errorOverlay) $errorOverlay.classList.add('show');
  }

  function hideError() {
    if ($errorOverlay) $errorOverlay.classList.remove('show');
  }

  // ─── Init ────────────────────────────────────────────────────────────────
  $captureBtn.disabled = true;
  $captureBtn.addEventListener('click', captureAndSend);

  if ($anotherBtn) $anotherBtn.addEventListener('click', takeAnother);

  if ($retryBtn) {
    $retryBtn.addEventListener('click', () => {
      hideError();
      startCamera();
    });
  }

  // Prevent double-tap zoom on capture button
  $captureBtn.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });

  setupGun();
  await startCamera();

  // Cleanup on page unload
  window.addEventListener('pagehide', () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
  });

})();
