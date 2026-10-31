/*
 * Scan with the phone or laptop camera, for people without a barcode
 * scanner. A camera button appears next to every scan field when the
 * browser can read barcodes itself (Chrome and Edge, on Android and
 * desktop); elsewhere nothing changes and typing still works. A read fills
 * the field just as a wedge scanner would: a one-field scan form is sent,
 * otherwise the cursor moves on to the next field.
 */
(function () {
  'use strict';
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  const FIELDS = 'input[data-scan], form.scan input:not([type=number]):not([type=hidden]), input[name=code], input[name=sscc], input[name=loc], input[name=q], input[name=from], input[name=to], input[name=itemNo], input[name=target], #scanIn';
  const FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'itf', 'qr_code', 'data_matrix'];
  let detector = null;

  const css = document.createElement('style');
  css.textContent = `
    .cam-row { display: flex; gap: 4px; align-items: center; }
    .cam-row > input { flex: 1 1 auto; min-width: 0; }
    .cam-row > .cam-btn { flex: none; width: auto; min-height: 0; font: 16px/1 system-ui, sans-serif; padding: 6px 8px; border-radius: 8px; border: 1px solid #bbb; background: #fff; color: #000; cursor: pointer; }
    .cam-wrap { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.85); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; }
    .cam-wrap video { width: min(100%, 640px); max-height: 70vh; border-radius: 12px; background: #000; }
    .cam-wrap .cam-aim { position: absolute; width: min(70%, 420px); height: 22%; border: 3px solid #4ade80; border-radius: 10px; pointer-events: none; }
    .cam-wrap p { color: #fff; margin: 0; font: 16px system-ui, sans-serif; text-align: center; }
    .cam-wrap button { font: 600 16px system-ui, sans-serif; padding: 10px 18px; border-radius: 10px; border: 0; }`;
  document.head.appendChild(css);

  async function getDetector() {
    if (detector) return detector;
    let formats = FORMATS;
    try { const ok = await window.BarcodeDetector.getSupportedFormats(); formats = FORMATS.filter((f) => ok.includes(f)); } catch (e) { /* use the list */ }
    detector = new window.BarcodeDetector({ formats });
    return detector;
  }

  function nextField(input) {
    const form = input.form;
    if (!form) return null;
    const fields = [...form.querySelectorAll('input:not([type=hidden]):not([type=checkbox]), select')].filter((f) => f.offsetParent !== null);
    return fields[fields.indexOf(input) + 1] || null;
  }

  function fill(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const form = input.form;
    const texts = form ? [...form.querySelectorAll('input:not([type=hidden]):not([type=checkbox])')].filter((f) => f.offsetParent !== null) : [];
    if (form && (form.classList.contains('scan') || texts.length === 1)) { form.requestSubmit(); return; }
    const next = nextField(input);
    (next || input).focus();
  }

  async function scanInto(input) {
    const wrap = document.createElement('div');
    wrap.className = 'cam-wrap';
    wrap.innerHTML = '<video playsinline muted></video><div class="cam-aim"></div><p>Hold the barcode inside the green box</p><button type="button">Cancel</button>';
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video');
    let stream = null;
    let done = false;
    const stop = () => {
      done = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
    };
    wrap.querySelector('button').onclick = () => { stop(); input.focus(); };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = stream;
      await video.play();
      const read = await getDetector();
      const tick = async () => {
        if (done) return;
        try {
          const found = await read.detect(video);
          if (found.length && !done) {
            const value = found[0].rawValue;
            if (navigator.vibrate) navigator.vibrate(60);
            stop();
            fill(input, value);
            return;
          }
        } catch (e) { /* frame not ready */ }
        setTimeout(tick, 120);
      };
      tick();
    } catch (e) {
      wrap.querySelector('p').textContent = e && e.name === 'NotAllowedError' ? 'The camera is blocked for this page. Allow it in the browser, or type the code.' : 'No camera could be opened. Type the code instead.';
    }
  }

  function add(input) {
    if (input.dataset.cam || input.type === 'number' || input.type === 'hidden' || input.type === 'password') return;
    input.dataset.cam = '1';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cam-btn';
    b.title = 'Scan with the camera';
    b.setAttribute('aria-label', 'Scan with the camera');
    b.textContent = '📷';
    b.onclick = (e) => { e.preventDefault(); scanInto(input); };
    // The field and its button side by side, inside whatever label held the field.
    const row = document.createElement('span');
    row.className = 'cam-row';
    input.replaceWith(row);
    row.append(input, b);
  }

  const sweep = () => document.querySelectorAll(FIELDS).forEach(add);
  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  else sweep();
  window.SortedCamera = { scanInto };
})();
