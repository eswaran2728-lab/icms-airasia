"use client";

import { useEffect, useRef, useState } from "react";
import { BarcodeDetector, setZXingModuleOverrides } from "barcode-detector/pure";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, X, Lightbulb } from "lucide-react";

// Self-host the ~1MB decoder .wasm from this app's own origin instead of
// the package's default jsDelivr CDN fetch (public/wasm/zxing_reader.wasm,
// copied from node_modules/zxing-wasm's matching version — see the
// zxing-wasm dependency pin in package.json if that ever needs updating).
// Airport/enterprise networks at checkpoints often block third-party CDNs
// outright, which silently starves every detect() call forever. Runs once
// at module load, before any BarcodeDetector is constructed.
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

// Thin bars decode far better with pixels to spare, so the crop is
// upscaled to at least this width before being handed to the decoder.
const MIN_CROP_DECODE_WIDTH = 1280;

// Decoding every animation frame is wasted work (battery/heat) without
// improving accuracy — throttle actual decode attempts.
const DECODE_FPS = 6;
const DECODE_INTERVAL_MS = 1000 / DECODE_FPS;

// Bumped whenever this file changes meaningfully — shown on-screen so a
// field report ("still doesn't work") can be checked against whether the
// device actually picked up the latest deploy before debugging further.
const SCANNER_BUILD = "diag-4";

/**
 * Live camera barcode scanner for physical seal tags.
 *
 * Decodes via the `barcode-detector` package (a WebAssembly build of the
 * real ZXing-C++ library) rather than the native BarcodeDetector API
 * (Safari has none, on iPhone or anywhere else) or html5-qrcode's weak
 * pure-JS fallback — same decode engine and accuracy on every platform.
 *
 * Every tick alternates between two decode passes, because each one
 * covers the other's blind spot:
 *  - the FULL camera frame, which cannot be thrown off by any mismatch
 *    between the on-screen guide box and the video's intrinsic pixel
 *    dimensions (letterboxing/object-fit), and
 *  - an upscaled centre CROP, which gives thin or small bars more pixels
 *    to work with than the full frame does.
 *
 * Accepts every symbology the engine supports rather than a hand-picked
 * list: seal tags come from whichever vendor supplied that batch, and
 * field testing showed the decoder running correctly (confirmed by the
 * on-screen frame counter) while a narrower format guess never matched.
 *
 * Only the .wasm decoder itself is fetched (once, self-hosted from this
 * app's own origin) — every scan afterwards is local, no per-scan
 * network call.
 */
export function SealBarcodeScanner({ onDetected, onClose }: SealBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

  useEffect(() => {
    activeRef.current = true;
    handledRef.current = false;
    lastDecodeRef.current = 0;
    passRef.current = 0;
    consecutiveErrorsRef.current = 0;
    setDecoderStatus("loading");
    setAttempts(0);
    detectorRef.current = new BarcodeDetector({
      // "any" is a format group meaning every symbology the engine
      // supports — 1D and 2D alike. Nothing is gained by narrowing it:
      // the decoder is no slower for accepting more, and a seal tag
      // printed in an unexpected symbology should still scan.
      formats: ["any"],
    });
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true }) ?? null;

    const drawUpscaledCrop = (video: HTMLVideoElement): HTMLCanvasElement | null => {
      if (!ctx || !canvas) return null;
      const sx = Math.round(video.videoWidth * CROP_LEFT_PCT);
      const sy = Math.round(video.videoHeight * CROP_TOP_PCT);
      const sw = Math.round(video.videoWidth * CROP_WIDTH_PCT);
      const sh = Math.round(video.videoHeight * CROP_HEIGHT_PCT);
      const scale = sw < MIN_CROP_DECODE_WIDTH ? MIN_CROP_DECODE_WIDTH / sw : 1;
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas;
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
        const source =
          passRef.current % 2 === 1 ? video : (drawUpscaledCrop(video) ?? video);

        try {
          const barcodes = await detectorRef.current!.detect(source);
          consecutiveErrorsRef.current = 0; // a clean resolve means the decoder is alive
          setDecoderStatus("ready");
          setAttempts((n) => n + 1);
          if (barcodes.length > 0) {
            handledRef.current = true;
            onDetectedRef.current(barcodes[0].rawValue.trim());
            return;
          }
        } catch (err) {
          // detect() rejecting is a real failure (decoder/wasm load
          // problem), not a "no barcode in this frame" miss — an empty
          // match resolves normally with barcodes.length === 0 instead.
          // A few isolated rejects can happen transiently; only give up
          // and surface an error once it's clearly not recovering.
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

      {/* Visible, not a debug artifact: this is the exact upscaled image
          handed to the decoder on crop passes. If the bars look sharp
          here and it still won't decode, that's a real bug worth
          reporting with a screenshot of this box. If they look blurry
          or smeared here, no decoder can read that — it's the shot, not
          the code. */}
      <div className="space-y-1">
        <p className="text-center text-xs text-muted-foreground">What the decoder sees:</p>
        <canvas
          ref={canvasRef}
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
        Fill the box with the barcode and hold steady about a hand&apos;s width away. Too much zoom
        makes it blurry — if it won&apos;t focus, zoom out and move closer instead.
      </p>
    </div>
  );
}
