/**
 * The slice of Shaka's text model the vendored CEA-708 decoder writes into.
 *
 * Shaka's own `lib/text/cue.js` is 955 lines and pulls in `ArrayUtils`,
 * `StringUtils`, `TextParser` and `TXml` behind it, to serve a text pipeline
 * this app does not have. The 708 window and utility code touches a dozen
 * fields of it. Those are declared here, typed, so that the compiler reports
 * anything the conversion missed rather than letting it fail silently at
 * runtime.
 *
 * Every field below exists because `cea708Window.ts` or `ceaUtils.ts` assigns
 * or reads it. Nothing here is aspirational, and nothing upstream sets that
 * they do not use has been carried over.
 */

/** Where a region's own anchor point and the viewport anchor are measured in. */
export const CueRegionUnits = {
  PX: 0,
  PERCENTAGE: 1,
  LINES: 2,
} as const;

export class CueRegion {
  /* The converted sources read `CueRegion.units`, as Closure wrote it. */
  static units = CueRegionUnits;

  id = "";
  /** The point within the region that `viewportAnchor` pins, in percent. */
  regionAnchorX = 0;
  regionAnchorY = 0;
  /** Where in the viewport that anchor sits. */
  viewportAnchorX = 0;
  viewportAnchorY = 0;
  width = 100;
  height = 100;
  widthUnits: number = CueRegionUnits.PERCENTAGE;
  heightUnits: number = CueRegionUnits.PERCENTAGE;
  viewportAnchorUnits: number = CueRegionUnits.PERCENTAGE;
}

export const CueTextAlign = {
  LEFT: "left",
  RIGHT: "right",
  CENTER: "center",
} as const;

export const CueFontStyle = {
  NORMAL: "normal",
  ITALIC: "italic",
} as const;

export const CueTextDecoration = {
  UNDERLINE: "underline",
  LINE_THROUGH: "lineThrough",
  OVERLINE: "overline",
} as const;

export class Cue {
  /* Read as `Cue.textAlign` and friends by the converted sources, which is
     how Closure exposed them. The instance fields of the same name below are
     upstream's too - a cue has a `textAlign`, and the class carries the set of
     values it may take. */
  static textAlign = CueTextAlign;
  static fontStyle = CueFontStyle;
  static textDecoration = CueTextDecoration;

  startTime: number;
  endTime: number;
  payload: string;

  region = new CueRegion();
  /**
   * Runs of differently-styled text within one cue.
   *
   * 708 changes pen colour and style mid-line, so a window becomes a cue
   * holding a run per style rather than one string.
   */
  nestedCues: Cue[] = [];
  /** True for the synthetic cue upstream inserts between rows. */
  lineBreak = false;

  textAlign: string = CueTextAlign.CENTER;
  fontStyle: string = CueFontStyle.NORMAL;
  textDecoration: string[] = [];
  color = "";
  backgroundColor = "";

  constructor(startTime: number, endTime: number, payload: string) {
    this.startTime = startTime;
    this.endTime = endTime;
    this.payload = payload;
  }

  /** The row separator upstream's `ceaUtils` builds. */
  static lineBreak(start: number, end: number): Cue {
    const cue = new Cue(start, end, "");
    cue.lineBreak = true;
    return cue;
  }
}
