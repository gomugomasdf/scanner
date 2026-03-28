/**
 * correction.js
 * Document image correction pipeline:
 *   1. Sobel edge detection + auto corner detection
 *   2. Perspective transform (via PerspT library)
 *   3. White balance correction
 *   4. jsPDF A4 PDF generation
 */

'use strict';

const Correction = (() => {

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function createOffscreenCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(w, h);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function imageDataFrom(img) {
    const c = createOffscreenCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { canvas: c, ctx, data: ctx.getImageData(0, 0, c.width, c.height) };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ─── Step 1: Sobel Edge Detection + Auto Corner Detection ─────────────────

  /**
   * Detect document corners using Sobel edge map + Hough-like quad search.
   * @param {HTMLImageElement|HTMLCanvasElement} imgEl
   * @returns {Array<{x,y}>|null}  [topLeft, topRight, bottomRight, bottomLeft] or null
   */
  function detectCorners(imgEl) {
    try {
      const origW = imgEl.naturalWidth || imgEl.width;
      const origH = imgEl.naturalHeight || imgEl.height;

      // Work at reduced resolution for performance
      const SCALE = 0.25;
      const sw = Math.round(origW * SCALE);
      const sh = Math.round(origH * SCALE);

      const c = createOffscreenCanvas(sw, sh);
      const ctx = c.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, sw, sh);
      const imgData = ctx.getImageData(0, 0, sw, sh);
      const pixels = imgData.data;

      // Convert to grayscale
      const gray = new Float32Array(sw * sh);
      for (let i = 0; i < sw * sh; i++) {
        const p = i * 4;
        gray[i] = pixels[p] * 0.299 + pixels[p+1] * 0.587 + pixels[p+2] * 0.114;
      }

      // Gaussian blur (3x3) to reduce noise
      const blurred = new Float32Array(sw * sh);
      const gk = [1,2,1, 2,4,2, 1,2,1]; // unnormalized kernel, divide by 16
      for (let y = 1; y < sh - 1; y++) {
        for (let x = 1; x < sw - 1; x++) {
          let s = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              s += gray[(y+ky)*sw + (x+kx)] * gk[(ky+1)*3 + (kx+1)];
            }
          }
          blurred[y*sw + x] = s / 16;
        }
      }

      // Sobel kernels
      const Gx = [-1,0,1, -2,0,2, -1,0,1];
      const Gy = [-1,-2,-1, 0,0,0, 1,2,1];
      const edgeMag = new Float32Array(sw * sh);
      let maxMag = 0;

      for (let y = 1; y < sh - 1; y++) {
        for (let x = 1; x < sw - 1; x++) {
          let gx = 0, gy = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const v = blurred[(y+ky)*sw + (x+kx)];
              gx += v * Gx[(ky+1)*3 + (kx+1)];
              gy += v * Gy[(ky+1)*3 + (kx+1)];
            }
          }
          const mag = Math.sqrt(gx*gx + gy*gy);
          edgeMag[y*sw + x] = mag;
          if (mag > maxMag) maxMag = mag;
        }
      }

      if (maxMag === 0) return null;

      // Threshold: keep top ~15% edge pixels
      const threshold = maxMag * 0.15;

      // Find corner candidates by quadrant
      // Divide image into 4 quadrants and find strongest edge point nearest each corner
      const margin = Math.round(Math.min(sw, sh) * 0.05);
      const halfW = sw / 2;
      const halfH = sh / 2;

      const quadrants = [
        { minX: margin, maxX: halfW, minY: margin, maxY: halfH },      // top-left
        { minX: halfW, maxX: sw-margin, minY: margin, maxY: halfH },   // top-right
        { minX: halfW, maxX: sw-margin, minY: halfH, maxY: sh-margin },// bottom-right
        { minX: margin, maxX: halfW, minY: halfH, maxY: sh-margin },   // bottom-left
      ];

      // Corner attraction: find the edge pixel in each quadrant
      // that maximizes: edgeMag * cornerAffinity
      // cornerAffinity = proximity to actual corner of quadrant
      const cornerTargets = [
        { cx: margin, cy: margin },          // TL
        { cx: sw-margin, cy: margin },        // TR
        { cx: sw-margin, cy: sh-margin },     // BR
        { cx: margin, cy: sh-margin },        // BL
      ];

      const detected = [];
      let totalConfidence = 0;

      for (let q = 0; q < 4; q++) {
        const quad = quadrants[q];
        const target = cornerTargets[q];
        let bestScore = -1;
        let bestX = -1, bestY = -1;

        const diagLen = Math.sqrt(sw*sw + sh*sh);

        for (let y = quad.minY; y < quad.maxY; y++) {
          for (let x = quad.minX; x < quad.maxX; x++) {
            const mag = edgeMag[y*sw + x];
            if (mag < threshold) continue;
            const dx = x - target.cx;
            const dy = y - target.cy;
            const dist = Math.sqrt(dx*dx + dy*dy);
            // Score: edge strength * proximity to corner
            const score = (mag / maxMag) * (1 - dist / diagLen);
            if (score > bestScore) {
              bestScore = score;
              bestX = x; bestY = y;
            }
          }
        }

        if (bestX < 0) return null; // couldn't find corner in quadrant

        totalConfidence += bestScore;
        // Scale back to original resolution
        detected.push({ x: Math.round(bestX / SCALE), y: Math.round(bestY / SCALE) });
      }

      const avgConfidence = totalConfidence / 4;

      // Confidence threshold: if too low, return null for manual fallback
      if (avgConfidence < 0.08) {
        console.log('[Sobel] Low confidence:', avgConfidence);
        return null;
      }

      console.log('[Sobel] Detected corners, confidence:', avgConfidence.toFixed(3), detected);
      // [topLeft, topRight, bottomRight, bottomLeft]
      return detected;

    } catch (e) {
      console.error('[Sobel] Error:', e);
      return null;
    }
  }

  // ─── Step 2: Perspective Transform ────────────────────────────────────────

  /**
   * Apply perspective transform to straighten document.
   * @param {HTMLImageElement|HTMLCanvasElement} imgEl
   * @param {Array<{x,y}>} corners [TL, TR, BR, BL] in original image coordinates
   * @returns {HTMLCanvasElement} transformed canvas (A4 aspect ratio)
   */
  function perspectiveTransform(imgEl, corners) {
    const [tl, tr, br, bl] = corners;

    // Calculate output dimensions using A4 aspect ratio (1:√2)
    // Estimate width and height from corners
    const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const bottomW = Math.hypot(br.x - bl.x, br.y - bl.y);
    const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

    const avgW = (topW + bottomW) / 2;
    const avgH = (leftH + rightH) / 2;

    // Enforce A4 ratio (height/width = √2 ≈ 1.4142)
    const A4_RATIO = Math.SQRT2;
    let outW, outH;
    if (avgH / avgW > A4_RATIO) {
      outH = Math.round(avgH);
      outW = Math.round(outH / A4_RATIO);
    } else {
      outW = Math.round(avgW);
      outH = Math.round(outW * A4_RATIO);
    }

    // Cap output resolution
    const MAX_DIM = 2480; // A4 at ~200 dpi
    if (outW > MAX_DIM) { outH = Math.round(MAX_DIM * A4_RATIO); outW = MAX_DIM; }
    if (outH > MAX_DIM * A4_RATIO + 10) { outH = Math.round(MAX_DIM * A4_RATIO); outW = MAX_DIM; }

    const outCanvas = createOffscreenCanvas(outW, outH);
    const outCtx = outCanvas.getContext('2d');

    // Source points (original image corners)
    const srcPts = [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y];
    // Destination points (rectangle)
    const dstPts = [0, 0, outW, 0, outW, outH, 0, outH];

    // Use PerspT (perspective-transform.js)
    if (typeof PerspT === 'undefined') {
      console.warn('[Transform] PerspT not available, using direct draw');
      outCtx.drawImage(imgEl, 0, 0, outW, outH);
      return outCanvas;
    }

    const transform = PerspT(srcPts, dstPts);

    // Inverse-map every output pixel to source
    // For large images this is slow; use chunked scanline approach
    const outImgData = outCtx.createImageData(outW, outH);
    const outPx = outImgData.data;

    // Draw source to a temp canvas to sample pixels
    const srcCanvas = createOffscreenCanvas(imgEl.naturalWidth || imgEl.width, imgEl.naturalHeight || imgEl.height);
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(imgEl, 0, 0);
    const srcImgData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const srcPx = srcImgData.data;
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;

    const inverseTransform = PerspT(dstPts, srcPts);

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const [sx, sy] = inverseTransform.transform(x, y);
        const si = Math.round(sy);
        const sj = Math.round(sx);
        if (si < 0 || si >= srcH || sj < 0 || sj >= srcW) continue;
        const srcIdx = (si * srcW + sj) * 4;
        const dstIdx = (y * outW + x) * 4;
        outPx[dstIdx]   = srcPx[srcIdx];
        outPx[dstIdx+1] = srcPx[srcIdx+1];
        outPx[dstIdx+2] = srcPx[srcIdx+2];
        outPx[dstIdx+3] = 255;
      }
    }

    outCtx.putImageData(outImgData, 0, 0);
    return outCanvas;
  }

  // ─── Step 3: White Balance Correction ─────────────────────────────────────

  /**
   * Correct white balance by sampling the brightest 10% of pixels as "paper white".
   * @param {HTMLCanvasElement} canvas  Input canvas (modified in-place)
   * @returns {HTMLCanvasElement} corrected canvas
   */
  function correctWhiteBalance(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const px = imgData.data;
    const n = w * h;

    // Compute brightness for each pixel
    const brightness = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      brightness[i] = px[p] * 0.299 + px[p+1] * 0.587 + px[p+2] * 0.114;
    }

    // Sort brightness values to find the 90th percentile threshold
    const sorted = brightness.slice().sort((a, b) => a - b);
    const threshold = sorted[Math.floor(n * 0.90)];

    // Sample brightest 10% pixels -> compute mean R, G, B ("paper white")
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    for (let i = 0; i < n; i++) {
      if (brightness[i] >= threshold) {
        const p = i * 4;
        sumR += px[p]; sumG += px[p+1]; sumB += px[p+2];
        count++;
      }
    }

    if (count === 0) return canvas;

    const paperR = sumR / count;
    const paperG = sumG / count;
    const paperB = sumB / count;

    // Scale factors to bring paper white to 255
    const scaleR = 255 / paperR;
    const scaleG = 255 / paperG;
    const scaleB = 255 / paperB;

    // Apply correction + slight contrast boost
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      px[p]   = clamp(Math.round(px[p]   * scaleR), 0, 255);
      px[p+1] = clamp(Math.round(px[p+1] * scaleG), 0, 255);
      px[p+2] = clamp(Math.round(px[p+2] * scaleB), 0, 255);
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  // ─── Step 4: PDF Generation ────────────────────────────────────────────────

  /**
   * Generate an A4 PDF from a canvas and trigger auto-download.
   * @param {HTMLCanvasElement} canvas
   * @param {string} [filename]
   */
  function generatePDF(canvas, filename = 'scanned-document.pdf') {
    if (typeof window.jspdf === 'undefined' && typeof jsPDF === 'undefined') {
      console.error('[PDF] jsPDF not loaded');
      alert('PDF 라이브러리 로드 실패. 페이지를 새로고침 후 다시 시도하세요.');
      return;
    }

    const { jsPDF } = window.jspdf || window;

    // A4 dimensions in mm
    const A4_W = 210;
    const A4_H = 297;

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    // Convert canvas to JPEG data URL
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    } catch(e) {
      // OffscreenCanvas doesn't have toDataURL - convert to regular canvas first
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, 0, 0);
      dataUrl = c.toDataURL('image/jpeg', 0.92);
    }

    // Fit image to A4 page preserving aspect ratio
    const imgAspect = canvas.width / canvas.height;
    const pageAspect = A4_W / A4_H;

    let imgW, imgH, offsetX, offsetY;
    if (imgAspect > pageAspect) {
      imgW = A4_W;
      imgH = A4_W / imgAspect;
      offsetX = 0;
      offsetY = (A4_H - imgH) / 2;
    } else {
      imgH = A4_H;
      imgW = A4_H * imgAspect;
      offsetX = (A4_W - imgW) / 2;
      offsetY = 0;
    }

    doc.addImage(dataUrl, 'JPEG', offsetX, offsetY, imgW, imgH);
    doc.save(filename);
  }

  // ─── Full Pipeline ─────────────────────────────────────────────────────────

  /**
   * Run the full correction pipeline.
   * @param {HTMLImageElement} imgEl  The source image element
   * @param {Array<{x,y}>} corners   [TL, TR, BR, BL] corner points
   * @param {function} onProgress    Called with (step: 1..4, message: string)
   * @returns {Promise<HTMLCanvasElement>} corrected canvas
   */
  async function runPipeline(imgEl, corners, onProgress = () => {}) {
    onProgress(1, '원근 변환 중...');

    // Yield to UI
    await new Promise(r => setTimeout(r, 50));

    let resultCanvas = perspectiveTransform(imgEl, corners);

    onProgress(2, '화이트밸런스 보정 중...');
    await new Promise(r => setTimeout(r, 50));

    // Convert OffscreenCanvas to regular Canvas if needed for compatibility
    if (typeof OffscreenCanvas !== 'undefined' && resultCanvas instanceof OffscreenCanvas) {
      const regular = document.createElement('canvas');
      regular.width = resultCanvas.width;
      regular.height = resultCanvas.height;
      regular.getContext('2d').drawImage(resultCanvas, 0, 0);
      resultCanvas = regular;
    }

    resultCanvas = correctWhiteBalance(resultCanvas);

    onProgress(3, '완료');
    await new Promise(r => setTimeout(r, 50));

    return resultCanvas;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    detectCorners,
    perspectiveTransform,
    correctWhiteBalance,
    generatePDF,
    runPipeline,
  };

})();
