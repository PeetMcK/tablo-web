#!/usr/bin/env bash
# Compile AppIcon.icon into the two things a macOS app bundle wants.
#
# `AppIcon.icon` is an Icon Composer document rather than an image: a folder
# holding the vector art plus `icon.json`, which describes the layers and how
# the system should light them. It carries the gradient in display-p3 and marks
# the glyph as a glass layer, which is why it cannot simply be exported as a
# PNG - the gradient, the specular highlight and the shadow are instructions
# for the compositor, not pixels.
#
# Two outputs, and the app needs both:
#
#   Assets.car   The real one on macOS 26 and later. An asset catalog, so it
#                carries those instructions and the system renders the icon
#                live - which is what makes it respond to Liquid Glass.
#                Goes in Contents/Resources, and the bundle's Info.plist needs
#                CFBundleIconName = AppIcon to find it.
#
#   AppIcon.icns The fallback, and it tops out at 256 - actool renders 16, 32,
#                128 and 256 from a `.icon` source and no more, at any
#                --minimum-deployment-target (checked at 26.0, 13.0 and 11.0,
#                byte-identical each time). That cap does not bite: the
#                catalog itself carries 32, 64, 128, 256, 512 and 1024 at both
#                scales, and `CFBundleIconName` has been read since macOS
#                10.13, so everything at or above our floor takes the icon
#                from Assets.car and never sees the icns.
#
# The icon is built for the current OS while the app's own floor is macOS 11.
# That is deliberate: this catalog should express everything the newest system
# can render, and the older ones take the same file with whatever they
# understand of it.
#
# The target changes nothing in the bytes - 26.0, 13.0 and 11.0 all produced
# byte-identical output - beyond the catalog's PlatformVersion stamp. Whether a
# Big Sur CoreUI refuses a catalog stamped newer than itself is **untested**;
# there is no macOS 11 here to try it on. If it does refuse, the icon falls
# back to AppIcon.icns and its 256px ceiling, which is a soft icon in Finder's
# larger views rather than a missing one.
#
# `actool` ships with macOS but needs Xcode installed to run. If a machine has
# no Xcode, compile this once elsewhere and commit the results.
#
# Method from https://www.hendrik-erz.de/post/supporting-liquid-glass-icons-in-apps-without-xcode
set -euo pipefail

# Absolute, both of them. `actool` resolves a relative path against something
# other than this script's working directory - a relative icon path came back
# as /private/tmp/AppIcon.icon - so neither is left to chance.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICON_PATH="$HERE/AppIcon.icon"
OUTPUT_PATH="$(cd "$(dirname "${1:-$HERE/build}")" 2>/dev/null && pwd)/$(basename "${1:-build}")"
PLIST_PATH="$OUTPUT_PATH/assetcatalog_generated_info.plist"

mkdir -p "$OUTPUT_PATH"

actool "$ICON_PATH" --compile "$OUTPUT_PATH" \
  --output-format human-readable-text --notices --warnings --errors \
  --output-partial-info-plist "$PLIST_PATH" \
  --app-icon AppIcon --include-all-app-icons \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 27.0 \
  --platform macosx

# The partial plist only restates CFBundleIconFile/CFBundleIconName, which the
# bundle's own Info.plist has to carry anyway.
rm -f "$PLIST_PATH"

echo
echo "built in $OUTPUT_PATH:"
ls -1 "$OUTPUT_PATH"
