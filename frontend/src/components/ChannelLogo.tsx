import { useState } from "react";
import { Antenna } from "lucide-react";

interface Props {
  src: string | null;
  callSign: string;
  className?: string;
}

/**
 * Channel logo with a graceful fallback.
 *
 * Logo URLs come from the Tablo cloud and the device, and some of them 404 —
 * a bare `<img>` then renders the browser's broken-image glyph. Both a missing
 * URL and a failed load fall back to an antenna mark.
 */
export function ChannelLogo({ src, callSign, className = "w-5 h-5" }: Props) {
  // Keyed by src so switching channels re-attempts rather than inheriting a
  // previous channel's failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    return <Antenna className={`${className} text-white/25`} aria-label={callSign} />;
  }

  return (
    <img
      src={src}
      alt={callSign}
      onError={() => setFailedSrc(src)}
      className="max-w-full max-h-full object-contain"
    />
  );
}
