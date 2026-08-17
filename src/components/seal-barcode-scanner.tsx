"use client";

import { useEffect, useRef, useState } from "react";
import { readBarcodes, setZXingModuleOverrides } from "zxing-wasm/reader";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, X, Lightbulb, Share2 } from "lucide-react";

// Self-host the ~1MB decoder .wasm from this app's own origin instead of
// the package's default jsDelivr CDN fetch (public/wasm/zxing_reader.wasm,
// copied from node_modules/zxing-wasm's matching version — see the
// zxing-wasm dependency pin in package.json if that ever needs updating).
// Airport/enterprise networks at checkpoints often block third-party CDNs
// outright, which silently starves every decode call forever. Runs once
// at module load, before any decode is attempted.
setZXingModuleOverrides({ locateFile: (path) => `/wasm/${path}` });

interface SealBarcodeScannerProps {
  /** Called with the decoded barcode text; parent closes the scanner. */
  onDetected: (value: string) => void;
  onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

// Centre region used for the close-up decode pass. Deliberately generous
// (not a tight 1D-shaped strip) so a slightly off-centre or tilted tag
// still lands fully inside it, quiet zones included — Code 128/39 need
// blank margin either side of the bars or they will not decode.
const CROP_WIDTH_PCT = 0.9;
const CROP_HEIGHT_PCT = 0.5;
const CROP_LEFT_PCT = (1 - CROP_WIDTH_PCT) / 2;
const CROP_TOP_PCT = (1 - CROP_HEIGHT_PCT) / 2;

// Decoding every animation frame is wasted work (battery/heat) without
// improving accuracy — throttle actual decode attempts.
const DECODE_FPS = 6;
const DECODE_INTERVAL_MS = 1000 / DECODE_FPS;

// Bumped whenever this file changes meaningfully — shown on-screen so a
// field report ("still doesn't work") can be checked against whether the
// device actually picked up the latest deploy before debugging further.
const SCANNER_BUILD = "diag-13";

/**
 * Live camera barcode scanner for physical seal tags.
 *
 * Decodes via zxing-wasm's readBarcodes() directly — NOT the higher-level
 * `barcode-detector`/`BarcodeDetector` wrapper this component used
 * previously. That wrapper hardcodes `returnErrors: false`, which means
 * ZXing silently drops any read that fails a mandatory format checksum
 * (Code 128, Code 93, ITF, EAN/UPC all require one) with no error and no
 * way to override it through that API. Field testing showed the decoder
 * running correctly against a visibly sharp, well-framed barcode image
 * (confirmed via the on-screen preview of the exact image handed to the
 * decoder) with zero results for hundreds of consecutive frames — the
 * signature of results being silently discarded, not of a decode
 * failure. `returnErrors: true` here surfaces those results instead of
 * dropping them — but they're still only ever a candidate, never
 * auto-accepted: only a result whose checksum actually validated
 * (`isValid`) is treated as a real read, so a checksum-failed decode
 * can't hand the officer a garbled value dressed up as a clean scan.
 *
 * Every tick alternates between two decode passes, because each one
 * covers the other's blind spot:
 *  - the FULL camera frame, which cannot be thrown off by any mismatch
 *    between the on-screen guide box and the video's intrinsic pixel
 *    dimensions (letterboxing/object-fit), and
 *  - a centre CROP at native resolution (no upscaling — see captureCrop
 *    for why that turned out to actively hurt decoding), which excludes
 *    whatever's outside the guide box that might confuse the decoder.
 *
 * Restricted to 1D (linear) formats only — Code 128/39/93, EAN/UPC, ITF,
 * Codabar, and the rest of the "AllLinear" group. Seal tags are always
 * linear barcodes; a 2D code elsewhere in frame (a shipping label, a
 * QR-based document) must never be returned as the result.
 *
 * Only the .wasm decoder itself is fetched (once, self-hosted from this
 * app's own origin) — every scan afterwards is local, no per-scan
 * network call.
 */
export function SealBarcodeScanner({ onDetected, onClose }: SealBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fullFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastDecodeRef = useRef(0);
  const passRef = useRef(0);
  const consecutiveErrorsRef = useRef(0);
  const activeRef = useRef(true);
  const handledRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // Diagnostic-only state: makes the invisible decode loop visible on the
  // officer's own screen, so "still not working" reports come back with
  // real signal instead of needing devtools access on a field device.
  const [decoderStatus, setDecoderStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempts, setAttempts] = useState(0);
  const [resolution, setResolution] = useState("");
  // Plain text, not an image — immune to every recompression step
  // (Photos library, chat upload, screenshot-of-a-viewer) that turned
  // out to be corrupting every image round-trip we tried. Shows the
  // best candidate readBarcodes() found on the last decode tick, valid
  // or not, so a report of "still not working" comes with exact ground
  // truth (what it read, which format, why it was rejected) instead of
  // a photo of unknown provenance.
  const [lastCandidate, setLastCandidate] = useState<string>("");
  // Aggregate, not last-tick-only: the full-frame and crop passes
  // alternate at ~3/sec each, so a single tick's outcome (what
  // lastCandidate shows) is one noisy sample, not evidence about the
  // whole session — a screenshot timed to a blank/miss tick looks
  // identical to a session where nothing ever worked. These counters
  // separate the two passes so a systematic problem in one specific
  // pass (e.g. a framing bug that only affects the crop) is visible
  // instead of averaged away.
  const statsRef = useRef({
    full: { attempts: 0, anyCandidate: 0, valid: 0 },
    crop: { attempts: 0, anyCandidate: 0, valid: 0 },
  });
  const [statsText, setStatsText] = useState("");
  // Direct check on the actual captured pixels: a blank/frozen/black
  // canvas (a known Safari drawImage(videoEl,...) failure mode on some
  // canvas configurations) would show zero candidates forever with no
  // other symptom — indistinguishable from "the barcode just won't
  // decode" without looking at the pixel data itself. min/max luminance
  // across a sample of pixels tells them apart: a real photo has a wide
  // spread (dark bars, light background); a blank capture doesn't.
  const [pixelStats, setPixelStats] = useState("");

  useEffect(() => {
    activeRef.current = true;
    handledRef.current = false;
    lastDecodeRef.current = 0;
    passRef.current = 0;
    consecutiveErrorsRef.current = 0;
    setDecoderStatus("loading");
    setAttempts(0);
    setLastCandidate("");
    statsRef.current = {
      full: { attempts: 0, anyCandidate: 0, valid: 0 },
      crop: { attempts: 0, anyCandidate: 0, valid: 0 },
    };
    setStatsText("");
    setPixelStats("");

    const previewCanvas = previewCanvasRef.current;
    const previewCtx = previewCanvas?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (!fullFrameCanvasRef.current) fullFrameCanvasRef.current = document.createElement("canvas");
    const fullFrameCanvas = fullFrameCanvasRef.current;
    const fullFrameCtx = fullFrameCanvas.getContext("2d", { willReadFrequently: true });

    // Cheap luminance spread check over a sample of pixels — a real
    // photo has a wide spread (dark bars against a lighter background);
    // a blank/frozen/black capture (a known Safari drawImage(videoEl)
    // failure mode on some canvas configurations) does not, and would
    // otherwise look identical to "the decoder just can't find it" from
    // the candidate counts alone.
    const summarizePixels = (img: ImageData): string => {
      const { data, width, height } = img;
      const totalPixels = width * height;
      const step = Math.max(4, Math.floor(totalPixels / 3000) * 4);
      let min = 255;
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += step) {
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
        sum += lum;
        n += 1;
      }
      const avg = n ? Math.round(sum / n) : 0;
      return `${width}x${height} lum ${Math.round(min)}-${Math.round(max)} avg${avg}`;
    };

    // Stretches whatever luminance contrast is actually present in this
    // specific image to fill the full 0-255 range. Matters most for the
    // crop pass: a global full-frame min/max (dominated by unrelated
    // high-contrast elements like paper or a nearby printed code) can
    // look fine while the barcode's own local region — especially dark
    // ink on a saturated colour like orange, which the eye reads as
    // high-contrast via hue but a luminance-only binarizer does not —
    // has a much narrower real range. Mutates in place; a no-op on an
    // already-blank/flat capture (nothing to stretch).
    const stretchContrast = (img: ImageData): void => {
      const { data } = img;
      let min = 255;
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      const range = max - min;
      if (range < 10) return;
      const scale = 255 / range;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.min(255, Math.max(0, (data[i] - min) * scale));
        data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] - min) * scale));
        data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] - min) * scale));
      }
    };

    // Crop pass: NOT upscaled — this crops the frame down to the guide
    // box for framing/focus only, drawn 1:1. Canvas upscaling can't add
    // real pixel detail to a video frame; it only stretches whatever is
    // already there, and doing that with a non-integer scale factor
    // produces visible moire banding (confirmed against a real capture)
    // that sits right on top of the bars and corrupts them regardless of
    // smoothing settings. Getting more real pixels onto the tag is the
    // camera's own zoom control's job, not a canvas resize's. Contrast
    // is stretched here (not on the full-frame pass — see
    // stretchContrast) and written back to the visible preview canvas,
    // so what's shown in "What the decoder sees" matches what's decoded.
    const captureCrop = (video: HTMLVideoElement): ImageData | null => {
      if (!previewCtx || !previewCanvas) return null;
      const sx = Math.round(video.videoWidth * CROP_LEFT_PCT);
      const sy = Math.round(video.videoHeight * CROP_TOP_PCT);
      const sw = Math.round(video.videoWidth * CROP_WIDTH_PCT);
      const sh = Math.round(video.videoHeight * CROP_HEIGHT_PCT);
      previewCanvas.width = sw;
      previewCanvas.height = sh;
      previewCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      const img = previewCtx.getImageData(0, 0, sw, sh);
      stretchContrast(img);
      previewCtx.putImageData(img, 0, 0);
      return img;
    };

    // Full-frame pass: the raw camera frame at native size, sidestepping
    // any crop/guide-box misalignment entirely.
    const captureFullFrame = (video: HTMLVideoElement): ImageData | null => {
      if (!fullFrameCtx) return null;
      fullFrameCanvas.width = video.videoWidth;
      fullFrameCanvas.height = video.videoHeight;
      fullFrameCtx.drawImage(video, 0, 0);
      return fullFrameCtx.getImageData(0, 0, fullFrameCanvas.width, fullFrameCanvas.height);
    };

    const scanLoop = async (video: HTMLVideoElement) => {
      if (!activeRef.current || handledRef.current) return;

      const now = performance.now();
      if (
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        now - lastDecodeRef.current >= DECODE_INTERVAL_MS
      ) {
        lastDecodeRef.current = now;
        passRef.current += 1;

        // Alternate full-frame and upscaled-crop passes — see the class
        // comment for why neither alone is sufficient.
        const passKind = passRef.current % 2 === 1 ? "full" : "crop";
        const image = passKind === "full" ? captureFullFrame(video) : captureCrop(video);

        if (image) {
          setPixelStats(`[${passKind}] ${summarizePixels(image)}`);
          try {
            const results = await readBarcodes(image, {
              // 1D formats only (Code 128/39/93, EAN/UPC, ITF, Codabar,
              // ...) — seal tags are always linear barcodes, and a QR/
              // DataMatrix code sitting nearby (e.g. a shipping label
              // behind the tag) must never be picked up as the result.
              formats: ["AllLinear"],
              tryHarder: true,
              // The critical option BarcodeDetector couldn't expose —
              // return checksum-failed/error reads instead of silently
              // discarding them. See the class comment.
              returnErrors: true,
              textMode: "Plain",
            });
            consecutiveErrorsRef.current = 0; // a clean resolve means the decoder is alive
            setDecoderStatus("ready");
            setAttempts((n) => n + 1);

            const s = statsRef.current[passKind];
            s.attempts += 1;
            const best = results[0];
            if (best) {
              s.anyCandidate += 1;
              if (best.isValid) s.valid += 1;
              setLastCandidate(
                `[${passKind}] ${best.format} "${best.text || "(empty)"}" valid=${best.isValid}${
                  best.error ? ` err="${best.error}"` : ""
                }`
              );
            } else {
              setLastCandidate(`[${passKind}] (no candidate this frame)`);
            }
            const f = statsRef.current.full;
            const c = statsRef.current.crop;
            setStatsText(
              `full ${f.attempts}att/${f.anyCandidate}cand/${f.valid}valid · crop ${c.attempts}att/${c.anyCandidate}cand/${c.valid}valid`
            );

            // returnErrors:true (above) surfaces checksum-failed reads
            // instead of silently dropping them — necessary to diagnose
            // the original bug, but it means garbled/misread attempts
            // now show up in `results` too. Only ever act on a read that
            // passed its format's checksum; a checksum-failed decode is
            // exactly as untrustworthy as it sounds; keep scanning.
            const hit = results.find((r) => r.isValid && r.text.trim().length > 0);
            if (hit) {
              handledRef.current = true;
              onDetectedRef.current(hit.text.trim());
              return;
            }
          } catch (err) {
            // A genuine rejection (decoder/wasm load problem), not a
            // "no barcode in this frame" miss — that resolves normally
            // with an empty results array instead. A few isolated
            // rejects can happen transiently; only give up and surface
            // an error once it's clearly not recovering.
            consecutiveErrorsRef.current += 1;
            console.error("Seal barcode decode failed:", err);
            if (consecutiveErrorsRef.current >= 5) {
              setDecoderStatus("failed");
              setError(
                "Barcode decoder failed to load — check your connection, or type the seal number instead."
              );
              activeRef.current = false;
              return;
            }
          }
        }
      }

      if (activeRef.current && !handledRef.current) {
        requestAnimationFrame(() => void scanLoop(video));
      }
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          },
        });
        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setScanning(true);

        // Zoom/torch capability varies by device — probe after the stream
        // starts. Torch matters more than it looks: seal tags are grey
        // plastic with grey print, and the extra light is often what
        // makes the bars resolvable at all.
        try {
          const track = stream.getVideoTracks()[0];
          const caps = track?.getCapabilities() as
            | (MediaTrackCapabilities & { zoom?: { min: number; max: number }; torch?: boolean })
            | undefined;
          if (caps?.zoom) setZoomSupported(true);
          if (caps?.torch) setTorchSupported(true);
          const settings = track?.getSettings();
          if (settings?.width && settings?.height) {
            setResolution(`${settings.width}×${settings.height}`);
          }
        } catch {
          // capability probing not supported on this browser — controls just won't show
        }

        requestAnimationFrame(() => void scanLoop(video));
      } catch {
        setError("Camera unavailable. Close this and type the seal number instead.");
      }
    })();

    return () => {
      activeRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    // Deliberately mount-once: onDetected is read via a ref (kept fresh
    // above) so the camera/decoder aren't torn down and rebuilt on every
    // parent re-render.
  }, []);

  const applyZoom = async (next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setZoom(clamped);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      await track?.applyConstraints({
        advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
      });
    } catch {
      // device doesn't actually support runtime zoom changes despite capability probe
    }
  };

  const toggleTorch = async () => {
    const next = !torchOn;
    setTorchOn(next);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      await track?.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
    } catch {
      // device doesn't actually support runtime torch control
    }
  };

  // Diagnostic: hands over the EXACT bytes fed to the decoder on the
  // last crop pass, so a "still doesn't work" report can be verified
  // against the real image instead of a screenshot's re-compression.
  const shareDecoderImage = () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], "seal-decoder-input.png", { type: "image/png" });
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
        share?: (data: { files: File[]; title?: string }) => Promise<void>;
      };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        nav.share({ files: [file], title: "Seal barcode decoder input" }).catch(() => undefined);
        return;
      }
      // Share API (or file sharing) unsupported here — open it directly
      // so it can be long-pressed and saved instead.
      window.open(URL.createObjectURL(blob), "_blank");
    }, "image/png");
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          Scan seal barcode{" "}
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            ({SCANNER_BUILD})
          </span>
        </p>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close scanner">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-lg border bg-black/90">
        <video ref={videoRef} playsInline muted autoPlay className="block w-full" />
        {/* Framing guide only — the full frame is decoded too, so a
            barcode slightly outside this box still scans. */}
        <div
          className="pointer-events-none absolute rounded-md border-2 border-amber-400/70"
          style={{
            left: `${CROP_LEFT_PCT * 100}%`,
            top: `${CROP_TOP_PCT * 100}%`,
            width: `${CROP_WIDTH_PCT * 100}%`,
            height: `${CROP_HEIGHT_PCT * 100}%`,
          }}
        />
      </div>

      {!scanning && !error ? (
        <p className="text-center text-sm text-muted-foreground">Starting camera…</p>
      ) : null}
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}
      {scanning ? (
        <p className="text-center font-mono text-xs text-muted-foreground">
          {decoderStatus} · {attempts} frames{resolution ? ` · ${resolution}` : ""}
        </p>
      ) : null}
      {lastCandidate ? (
        <p className="text-center font-mono text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          {lastCandidate}
        </p>
      ) : null}
      {statsText ? (
        <p className="text-center font-mono text-[11px] leading-snug text-muted-foreground">
          {statsText}
        </p>
      ) : null}
      {pixelStats ? (
        <p className="text-center font-mono text-[11px] leading-snug text-sky-700 dark:text-sky-400">
          {pixelStats}
        </p>
      ) : null}

      {/* Visible, not a debug artifact: this is the exact image handed
          to the decoder on crop passes. Read `lastCandidate` above, not
          this box, for reporting a problem — that text can't be
          recompressed or rescaled by a photo/chat pipeline the way this
          image can (learned that the hard way). */}
      <div className="space-y-1">
        <div className="flex items-center justify-center gap-2">
          <p className="text-center text-xs text-muted-foreground">What the decoder sees:</p>
          {attempts > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Save or share this exact image"
              onClick={shareDecoderImage}
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <canvas
          ref={previewCanvasRef}
          className="mx-auto block w-full max-w-xs rounded-md border bg-black/90"
        />
      </div>

      {zoomSupported || torchSupported ? (
        <div className="flex items-center justify-center gap-3">
          {zoomSupported ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Zoom out"
                onClick={() => applyZoom(zoom - ZOOM_STEP)}
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center font-mono text-sm">{zoom.toFixed(1)}×</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Zoom in"
                onClick={() => applyZoom(zoom + ZOOM_STEP)}
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {torchSupported ? (
            <Button
              type="button"
              variant={torchOn ? "default" : "outline"}
              size="icon"
              aria-label={torchOn ? "Turn off light" : "Turn on light"}
              onClick={() => void toggleTorch()}
            >
              <Lightbulb className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        Use zoom to fill the box with the barcode — the closer/bigger it looks here, the better it
        reads. If it won&apos;t focus at high zoom, zoom out and move physically closer instead.
      </p>
    </div>
  );
}
