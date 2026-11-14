#!/bin/sh
# __NAME__ __VERSION__: installera eller uppdatera med ett kommando.
#   curl -fsSL __BASE__/install.sh | sh
# Skapas av desktop/publish.mjs vid varje version, med filernas adresser och
# SHA-256 inskrivna. curl sätter ingen karantän på filen, så macOS frågar inte;
# stämmer inte kontrollsumman avbryts allt innan något installeras.
set -eu

NAME='__NAME__'
VERSION='__VERSION__'
MAC_ARM64_URL='__MAC_ARM64_URL__'
MAC_ARM64_SHA='__MAC_ARM64_SHA__'
MAC_X64_URL='__MAC_X64_URL__'
MAC_X64_SHA='__MAC_X64_SHA__'
APPIMAGE_URL='__APPIMAGE_URL__'
APPIMAGE_SHA='__APPIMAGE_SHA__'
ICON_URL='__BASE__/icon.png'
SLUG='__FILEBASE__'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
say() { printf '%s\n' "$*"; }
fail() { printf 'Fel: %s\n' "$*" >&2; exit 1; }

fetch() { # url fil sha
  [ -n "$1" ] || fail "ingen fil för den här datorn i version $VERSION"
  say "Laddar ner $NAME $VERSION..."
  curl -fSL --progress-bar "$1" -o "$2"
  if command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$2"); else sum=$(sha256sum "$2"); fi
  [ "${sum%% *}" = "$3" ] || fail "kontrollsumman stämmer inte. Inget installerades."
}

case "$(uname -s)" in
Darwin)
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
    fetch "$MAC_ARM64_URL" "$tmp/app.zip" "$MAC_ARM64_SHA"
  else
    fetch "$MAC_X64_URL" "$tmp/app.zip" "$MAC_X64_SHA"
  fi
  ditto -x -k "$tmp/app.zip" "$tmp/x"
  [ -d "$tmp/x/$NAME.app" ] || fail "oväntat innehåll i paketet"
  dest="${BOOQY_INSTALL_DIR:-/Applications}"
  if [ ! -w "$dest" ]; then
    dest="$HOME/Applications"
    mkdir -p "$dest"
    say "Ingen skrivrätt till /Applications, installerar i $dest."
  fi
  app="$dest/$NAME.app"
  # Stäng en öppen äldre version (bara den på just den här platsen).
  pkill -f "$app/Contents/MacOS/" 2>/dev/null && sleep 2 || true
  rm -rf "$app"
  ditto "$tmp/x/$NAME.app" "$app"
  xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
  say "Klart: $app"
  [ "${BOOQY_NO_OPEN:-0}" = 1 ] || open "$app"
  ;;
Linux)
  [ "$(uname -m)" = x86_64 ] || fail "bara 64-bitars Intel/AMD (x86_64) stöds"
  fetch "$APPIMAGE_URL" "$tmp/app.AppImage" "$APPIMAGE_SHA"
  bin="$HOME/.local/bin"
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons"
  mkdir -p "$bin" "$apps" "$icons"
  install -m 755 "$tmp/app.AppImage" "$bin/$SLUG.AppImage"
  curl -fsSL "$ICON_URL" -o "$icons/$SLUG.png" || true
  cat > "$apps/$SLUG.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$NAME
Exec="$bin/$SLUG.AppImage" %U
Icon=$icons/$SLUG.png
Terminal=false
Categories=Office;
DESKTOP
  say "Klart: $bin/$SLUG.AppImage (finns i programmenyn som $NAME)"
  [ "${BOOQY_NO_OPEN:-0}" = 1 ] || (nohup "$bin/$SLUG.AppImage" >/dev/null 2>&1 &)
  ;;
*)
  fail "kör install.ps1 på Windows: irm __BASE__/install.ps1 | iex"
  ;;
esac
