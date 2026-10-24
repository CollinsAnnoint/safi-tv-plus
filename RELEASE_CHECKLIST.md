# SAFI TV+ release checklist

## Before building

- [ ] Confirm `CONFIG.version`, Android `versionName`, service-worker cache name and asset query strings match.
- [ ] Run `bash sync-web.sh` and confirm Android assets match `web/`.
- [ ] Run JavaScript/Python syntax checks.
- [ ] Boot the app and confirm the splash is removed and Home is not blocked.
- [ ] Test Home, Live, Radio, Movies, Kids, Apps, Search, Favourites, All Channels, Auto-Scan, Offline, Help and Settings.
- [ ] Test Previous, Next, Home, player Previous/Next, and Exit.
- [ ] Test on a wide TV layout, a laptop window and a narrow phone-sized window.
- [ ] Confirm the top wallpapers load and transition.
- [ ] Run Channel Doctor on a small filtered list before a full scan.
- [ ] Confirm Auto-Scan mode is the intended one (`auto`, `weekly`, `weeklyRadio`, or `off`).

## Android release

- [ ] Build **signed release**, not debug, for distribution.
- [ ] Keep the keystore and passwords offline/GitHub Secrets only — never commit them.
- [ ] Install the release APK over the previous signed version and confirm settings/favourites survive.
- [ ] Test D-pad focus, Back/Previous behaviour, file picker, recording (if supported), embedded channels and the native Booster.
- [ ] Record the SHA-256 checksum from the build artifact.

## Web/home-server release

- [ ] Keep `server.py` on the home LAN only.
- [ ] Leave `SAFI_ALLOW_PRIVATE_STREAMS` unset unless a trusted LAN media server is required.
- [ ] Reload once after deployment so the network-first service worker picks up the new version.

## Rollback

- Keep the previous signed APK and previous web ZIP.
- If a release fails, reinstall the previous signed APK or restore the previous `web/` folder and restart the server.
