import { useState } from "react";
import { Antenna } from "lucide-react";

interface Props {
  src: string | null;
  callSign: string;
  className?: string;
}

// The logo sits on its own plate rather than directly on whatever surface the
// caller provides. Station marks are broadcast artwork we do not control and
// are overwhelmingly white-on-transparent, so on a light surface they simply
// vanish. The plate is therefore dark in both themes, and a channel's mark
// looks identical whichever theme is on; the antenna fallback keeps the same
// dark-backed context.
//
// `logo-plate` rather than `media`: `media` is pure black, which would be a
// visible change against the #0f0f18 / #09090f the two callers put behind a
// logo today. `logo-plate` is #0c0c14 in dark — within 5/255 of both — and the
// ink colour in light, which is quieter on a warm page than a black slab.
//
// `w-full h-full` fills the caller's padded box exactly, so the image's
// `max-w-full max-h-full object-contain` resolves against the same rectangle it
// did before the plate existed and nothing reflows.
const PLATE =
  "w-full h-full flex items-center justify-center overflow-hidden rounded-md bg-logo-plate";

/**
 * Channel logo with a graceful fallback.
 *
 * Logo URLs come from the Tablo cloud and the device, and some of them 404 —
 * a bare `<img>` then renders the browser's broken-image glyph. Both a missing
 * URL and a failed load fall back to an antenna mark.
 */
export function ChannelLogo({ src, callSign, className = "w-7 h-7" }: Props) {
  // Keyed by src so switching channels re-attempts rather than inheriting a
  // previous channel's failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    // Antenna is four diagonal strokes plus a stem. At 24px with the default
    // stroke-width of 2 they collide and read as hatching, so it is drawn larger
    // and thinner.
    return (
      <span className={PLATE}>
        <Antenna
          // /30 measured 2.71:1 light and 2.63:1 dark against the plate, under
          // the 3:1 bar for a graphic. This is the only channel mark when a
          // logo 404s and it carries the call sign, so it is not decoration.
          className={`${className} text-media-fg/45`}
          strokeWidth={1.25}
          aria-label={callSign}
        />
      </span>
    );
  }

  return (
    <span className={PLATE}>
      <img
        src={src}
        alt={callSign}
        onError={() => setFailedSrc(src)}
        className="max-w-full max-h-full object-contain"
      />
    </span>
  );
}
