# SAFI TV+ security model

## Important reality about “encrypting the code”

Any JavaScript, CSS or stream URL delivered to a TV, phone or laptop can be inspected by the person who owns that device. Obfuscation/minification makes casual copying harder; it is not encryption and must never be treated as a safe place for passwords, private API keys or paid-service credentials.

SAFI TV+ therefore uses a safer design:

- **No accounts and no embedded secrets.** The app contains no private API keys, passwords or signing keys.
- **Android release builds** use R8 shrinking/obfuscation and must be signed with a private keystore kept outside the repository.
- **Android updates are trusted by signature.** Android only accepts an update signed with the same key as the installed app. Protect that keystore and its passwords; losing it prevents normal updates.
- **Web updates are same-origin only.** The service worker caches only this app's own interface files and uses network-first loading with an offline fallback.
- **No outside navigation.** The Android shell blocks top-level navigation away from the app origin, drops external schemes and refuses popup windows. Embedded players run without popup/top-navigation permissions.
- **Least-privilege WebView.** File/content URL access, form/password saving, geolocation and Web SQL are disabled. Only the small toast/home-state/exit/Booster-state bridge is exposed.
- **Local data stays local.** Preferences, favourites, scanned channels, history and offline media are stored on the device. Android backup is disabled.

## Home server / Booster

`server.py` is intended for a trusted home LAN only.

- It only proxies public media URLs after validation.
- Private, loopback, link-local and cloud-metadata destinations are blocked by default.
- Set `SAFI_ALLOW_PRIVATE_STREAMS=1` only if you deliberately need a trusted LAN media server.
- Never port-forward it or publish `/proxy` on the internet.

## Auto-Scan trust rules

Auto-Scan can only add a channel when:

1. The source is the bundled directory, iptv-org Kenya, or Radio Browser.
2. The stream is HTTPS and passes a live playlist + media test (TV) or live-audio test (radio).
3. Finished/VOD HLS playlists (`#EXT-X-ENDLIST`) and DRM-style key formats that the standard player cannot handle are rejected.
4. Duplicate names/URLs are skipped.

Broadcasters can still change or stop a stream after it passes. **Channel Doctor** is the re-check tool.

## Reporting a problem

Report crashes, broken navigation or security concerns privately to the project owner. Include the app version, device/TV model, Android/browser version, the screen/channel involved, and the exact steps to reproduce it. Do not post private playlist URLs or passwords publicly.
