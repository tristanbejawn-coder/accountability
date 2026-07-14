// PoseLandmarker wrapper (MediaPipe tasks-vision, loaded from CDN).
// One model provides both landmarks (calibration scan) and a person
// segmentation mask (scoring). `Tracker.stub` lets tests inject fake results.

const Tracker = {
  landmarker: null,
  failed: false,
  stub: null,
  _lastTs: 0,

  ready() {
    return !!(this.landmarker || this.stub);
  },

  async load() {
    if (this.stub) return true;
    if (this.landmarker) return true;
    const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
    try {
      let mp;
      try {
        mp = await import(`${CDN}/vision_bundle.mjs`);
      } catch (e) {
        mp = await import(`${CDN}/+esm`);
      }
      const files = await mp.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      this.landmarker = await mp.PoseLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        outputSegmentationMasks: true,
      });
      return true;
    } catch (e) {
      console.warn('Pose model unavailable, falling back:', e);
      this.failed = true;
      return false;
    }
  },

  // Runs detection on the current video frame. Returns
  // { landmarks, maskCanvas } or null. maskCanvas (unmirrored, video-sized,
  // person drawn in red) is only produced when wantMask is true.
  detect(video, wantMask = false) {
    if (this.stub) return this.stub(wantMask);
    if (!this.landmarker || !video.videoWidth) return null;
    this._lastTs = Math.max(performance.now(), this._lastTs + 1);
    let res;
    try {
      res = this.landmarker.detectForVideo(video, this._lastTs);
    } catch (e) {
      return null;
    }
    const landmarks = res.landmarks && res.landmarks[0];
    let maskCanvas = null;
    if (res.segmentationMasks) {
      for (const mask of res.segmentationMasks) {
        if (wantMask && landmarks && !maskCanvas) maskCanvas = maskToCanvas(mask);
        try { mask.close(); } catch (e) {}
      }
    }
    return landmarks ? { landmarks, maskCanvas } : null;
  },
};

function maskToCanvas(mask) {
  const w = mask.width;
  const h = mask.height;
  const arr = mask.getAsFloat32Array();
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = arr[i] > 0.5 ? 255 : 0;
    img.data[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
