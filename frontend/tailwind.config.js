/** @type {import('tailwindcss').Config} */

// Every colour in the app comes from a CSS custom property holding a
// space-separated RGB triplet (see src/index.css). One class therefore works in
// both themes with no `dark:` variant at the call site, and the theme swap is a
// single class on <html>.
//
// Two shapes of token:
//
//   rgb(...)  - opaque token. Tailwind's opacity modifiers work as normal, so
//               `bg-surface-raised/60` and `text-fg-muted/70` still do what you
//               expect.
//   rgba(...) - token that is *translucent by nature* (borders, hover fills,
//               scrims, glows). The alpha lives in a companion `--x-a` variable
//               so each theme can pick its own strength - light needs a much
//               weaker ink wash than dark needs a white one. Do NOT put an
//               opacity modifier on these; it is ignored.
const rgb = (name) => `rgb(var(--${name}) / <alpha-value>)`
const rgba = (name) => `rgb(var(--${name}) / var(--${name}-a))`

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ---- Surfaces: the app's elevation ladder -------------------------
        surface: {
          DEFAULT: rgb("c-bg"), // page background
          raised: rgb("c-bg-raised"), // cards, panels, sheets
          overlay: rgb("c-bg-overlay"), // menus, popovers, dialogs
          sunken: rgb("c-bg-sunken"), // wells, inset rows, logo tiles
          border: rgba("c-border"), // deprecated alias -> use `border-border`
        },

        // ---- Foreground: the text ladder ---------------------------------
        fg: {
          DEFAULT: rgb("c-fg"), // primary text
          secondary: rgb("c-fg-secondary"), // supporting text
          muted: rgb("c-fg-muted"), // labels, metadata
          subtle: rgb("c-fg-subtle"), // quieter metadata
          faint: rgb("c-fg-faint"), // icons, timestamps (non-body)
          disabled: rgb("c-fg-disabled"), // disabled text, placeholders
        },

        // ---- Raw tints: the escape hatch, always used with a modifier -----
        tint: rgb("c-tint"), // contrast tint  (white in dark, ink in light)
        ink: rgb("c-ink"), // darkening tint (black in dark, ink in light)

        // ---- Translucent fills -------------------------------------------
        fill: {
          soft: rgba("c-fill-soft"), // resting chip / row wash
          DEFAULT: rgba("c-fill"), // hover
          strong: rgba("c-fill-strong"), // active / pressed
        },
        recess: {
          soft: rgba("c-recess-soft"), // subtle darkening
          DEFAULT: rgba("c-recess"), // wells, sticky headers over content
          strong: rgba("c-recess-strong"), // badges over imagery
        },

        // ---- Borders ------------------------------------------------------
        border: {
          subtle: rgba("c-border-subtle"), // hairlines, row separators
          DEFAULT: rgba("c-border"), // card and control outlines
          medium: rgba("c-border-medium"), // hover/emphasis on a control outline
          strong: rgba("c-border-strong"), // meaningful outlines (>= 3:1)
        },

        // ---- Brand --------------------------------------------------------
        accent: {
          DEFAULT: rgb("c-accent"),
          fg: rgb("c-accent-fg"), // text/icons on an accent fill
          soft: rgba("c-accent-soft"), // tinted accent background
          strong: rgb("c-accent-strong"), // text/icons ON an accent-soft fill
          glow: rgba("c-accent-glow"), // shadow/ring glow
        },
        brand: {
          from: rgb("c-brand-from"), // gradient start (blue)
          to: rgb("c-brand-to"), // gradient end (violet)
        },

        // ---- Status -------------------------------------------------------
        danger: {
          DEFAULT: rgb("c-danger"), // text/icon on a surface
          solid: rgb("c-danger-solid"), // filled button, live dot
          fg: rgb("c-danger-fg"), // text on the solid fill
          soft: rgba("c-danger-soft"), // tinted background
        },
        success: {
          DEFAULT: rgb("c-success"),
          solid: rgb("c-success-solid"),
          fg: rgb("c-success-fg"),
          soft: rgba("c-success-soft"),
          "soft-strong": rgba("c-success-soft-strong"), // hover above soft
        },
        warning: {
          DEFAULT: rgb("c-warning"),
          solid: rgb("c-warning-solid"),
          fg: rgb("c-warning-fg"),
          soft: rgba("c-warning-soft"),
        },

        // ---- Depth --------------------------------------------------------
        scrim: {
          DEFAULT: rgba("c-scrim"), // modal backdrop
          soft: rgba("c-scrim-soft"), // hover veil over imagery
        },
        shade: {
          DEFAULT: rgba("c-shade"), // shadow / ring colour
          soft: rgba("c-shade-soft"),
        },

        // ---- Over video and imagery ---------------------------------------
        // These sit on pixels we do not control, so `media-fg` stays white in
        // both themes. The player's own *panels* do flip with the theme.
        media: {
          DEFAULT: rgb("c-media"), // letterbox behind the video
          fg: rgb("c-media-fg"),
          "fg-muted": rgb("c-media-fg-muted"),
        },
        // Opaque dark plate behind a station logo. Dark in BOTH themes, because
        // broadcast marks are white-on-transparent, but not `media`'s pure
        // black: it sits on a page, not on video.
        "logo-plate": rgb("c-logo-plate"),
        player: {
          panel: rgba("c-player-panel"), // control bar, popovers
          "panel-strong": rgba("c-player-panel-strong"), // tooltips
          "panel-soft": rgba("c-player-panel-soft"), // thumbnail chrome
          fg: rgb("c-player-fg"), // text/icons on a player panel
          "fg-muted": rgb("c-player-fg-muted"),
          border: rgba("c-player-border"),
          track: rgba("c-player-track"), // scrubber trough
          buffered: rgba("c-player-buffered"), // buffered ahead
        },
      },
      ringOffsetColor: {
        DEFAULT: rgb("c-bg"),
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
}
