# 📺 SAFI TV+ — Smart TV / Smart Box Software

> **v2.0.0 — Google TV-style home screen, Auto-Scan + Radio**
>
> **384 curated TV channels** • **66 radio stations** • **7,471 World Directory channels** • Movies • Kids • Offline/USB  
> 🔒 Everything plays **inside SAFI TV+**. It never redirects you to YouTube, a browser or another app.

SAFI TV+ is complete IPTV + streaming software for **Android Smart TV / Android TV boxes**, built for home use in Kenya 🇰🇪. The same web interface also runs in a TV/desktop browser for testing.

---

## ✨ What you get

### 📺 Live TV

- **384 built-in curated TV channels**, with backups/mirrors on selected stations.
- **20 watchable Kenyan online stations** across Kenya/Gospel/Kids categories — every Kenyan HLS feed still listed passed a live playlist+segment test on 23 Oct 2026; Citizen/NTV/KTN use current official live players.
- **138 more Kenyan local stations listed** in **Channels → 🇰🇪 Kenya — All Local**. These currently have no public online stream we can legally play in-app, so SAFI labels them **📡 Aerial only** instead of pretending they are online channels.
- Every built-in TV category has **at least 11 channels**:

  Africa 34 • Telenovelas 28 • Soaps & Dramas 22 • Movies 21 • Sports 28 • News 19 • Music 25 • Kenya 16 • Comedy 14 • Cooking & Food 14 • Gospel 14 • World TV 17 • Series 13 • Kids 13 • Business 12 • Fashion 12 • Travel 12 • Lifestyle 12 • Documentary 12 • Education & Culture 12 • Entertainment 12 • Anime & Toons 11 • Classic TV 11

- **All Channels A–Z:** one searchable list with category and A–Z letter filters.
- **World Directory:** 7,471 additional publicly listed channels from 178 countries, loaded only when opened so the app stays fast. These are public listings, so live status varies — use **🩺 Check this list** there.
- **Resilient Player Engine:** Direct → Mirrors → ⚡ Booster → official embedded fallback, with retries and a manual **🔁 Source** button.

> Citizen TV, NTV, KTN, KBC, TV47, Ramogi, Kameme, Ebru and similar stations with no public HLS feed use an official embedded player shown **inside the SAFI player**. The iframe is sandboxed with no popups/top-navigation, so it cannot open the YouTube app/site or a browser. Press **Back** to return.

### 🛰 Auto-Scan — new channels added automatically

Open **Auto-Scan** from the top bar, Live TV, Apps, Help or Settings.

- Sources: **Kenya TV**, **Africa TV**, **World TV**, **Kenya Radio**, **World Radio**.
- SAFI downloads a public source list, removes duplicates, then performs a real playback test.
- TV is added only after a valid HLS playlist **and media segment** are received.
- Radio is added only after live audio is received.
- New TV appears in the TV Guide and **🛰 Auto-Scan** category. New radio appears in the Radio page.
- Choose **50 / 100 / 200 / 400** candidates per scan. Repeat scans continue through fresh portions of large directories.
- Automatic mode is **ON by default**: it checks Kenya TV + Radio daily and Africa TV weekly in the background (only when online and not watching), then adds new verified channels automatically. You can change it to Weekly-only or OFF in Auto-Scan.
- **Clear scanned additions** removes everything Auto-Scan added, without touching the built-in catalogue.

> Auto-Scan uses internet data and only adds publicly listed streams that work at test time. A broadcaster can still go offline later. This is **internet scanning**, not DVB-T2/FM tuner control — a web app cannot operate the TV tuner.

### 📻 Radio — online + offline

66 verified built-in stations:

- **44 Kenyan stations**, including Radio Citizen, Inooro FM, Ramogi FM, Classic 105, Kiss 100, Radio Jambo, Capital FM, Radio Maisha, Spice FM, Milele FM, Kameme FM, Homeboyz Radio, Ghetto Radio, Hope FM, KBC Radio Taifa and Royal Media vernacular stations.
- **22 world stations**, including BBC World Service, NPR, WNYC, France Info, FIP, several SomaFM music stations, Galaxy FM Uganda and Afrobeats Gospel Radio.

**Offline radio:**

1. Listen to a station online.
2. Press **⏺ Record** in the player. Radio auto-stops after **30 minutes** unless you stop sooner.
3. Replay it with zero data in **Offline / USB**.
4. Or copy MP3/AAC/M4A/OGG/WAV files to a flash disk and choose **Radio → Play USB / Saved Audio File**.

> Honest physics: software cannot create a live FM signal when the device has no internet or accessible FM tuner. SAFI's real offline radio is recordings, downloaded audio and USB files. Internet radio uses roughly **25–60 MB/hour**, far less than TV.

### 🎨 Interface & settings

- **Midnight Violet redesign:** near-black indigo glass panels, burnt-orange highlights, a dashboard hero with Live TV/Movies/Radios modules, and **9 transitioning cinematic wallpapers** across the top (Nature, Kenya, Telenovela, Movies, Sports, News, Kids, Music, Travel).
- Apple TV/Google TV-style confidence touches: large artwork, clear focus rings, Recently Watched, quick settings and consistent Back behaviour.
- **🇵🇭 Filipino Teleserye:** Kapamilya Online Live (ABS-CBN), Jeepney TV, TV5, NET25, FilAmTV + Todo Novelas — the free, legal equivalents of pay-TV's Novela E Plus (StarTimes subscription channel; no public stream exists to add).
- **Who's watching? collections:** 👨‍👩‍👧 Family Time, 🎉 With Friends, 🍿 Movie Night, 💃 Telenovela Nights and 🧘 Solo & Relax blend categories for one person, friends or family.
- **Language:** Settings → 🌐 **Language / Lugha** — English, Kiswahili or Français (menus, categories and settings).
- **Settings quick bar:** Low-Data, Channel Doctor, Large Text, Reduce Motion, All Channels, Auto-Scan, Radio, Storage & Offline, Help, online/Booster status.
- **Navigation:** global **← Previous / ⌂ Home / Next →** buttons, Previous/Next pages in long channel lists, Previous/Next channel + Home + Exit in the player, and a real Exit button (closes the APK on Android TV).
- Theme colours, favourites, watch history, movie resume, channel-number tuning and on-screen remote keyboard.
- **Channel Doctor** marks channels Working / Booster / Embedded / Offline for 24 hours and can hide dead ones.

---

## 🚀 Run it today in a browser

### Fast preview / TV browser

Open the live preview address supplied with this software, or start the home server below and open it on the TV browser.

### Recommended home browser server (enables ⚡ Booster)

On a computer connected to the same home Wi-Fi:

```bash
cd smart-tv-box
python3 server.py 8000
```

Then on the TV browser open:

```text
http://<computer-local-IP>:8000
```

`server.py` serves the app and provides the media-only Stream Booster. It repairs many public streams whose CORS/referrer rules block a TV browser.

> ⚠️ **Security:** keep `server.py` on your **home LAN only**. Never port-forward it or publish its `/proxy` endpoint on the internet.

---

## 📦 Install as a real Android TV app (APK)

The APK is the best way to use SAFI TV+: the native Booster is built in and no computer/server is needed.

### Option A — GitHub builds it free

1. Create a free GitHub repository and upload this whole `smart-tv-box` folder.
2. Open **Actions → Build SAFI TV+ APK → Run workflow** (controlled builds only; or push a `v*` version tag).
3. When it is green, open the run and download **SafiTV-APK**.
4. Unzip to get `app-debug.apk`.

### Option B — Android Studio

1. Open `android-tv/` in Android Studio.
2. If you changed `web/`, first run `./sync-web.sh` (Linux/macOS) or `sync-web.bat` (Windows).
3. Use **Build → Build APK(s)**.

### Install on the TV/box

1. Copy `app-debug.apk` to a USB flash disk and plug it in.
2. Allow **Install unknown apps** for your file manager in TV Settings.
3. Open the APK and choose **Install**.
4. Launch **SAFI TV+** from the TV Apps row.

Works on Android TV / Google TV / Android TV boxes running Android 5.0+ (`minSdk 21`). This sandbox has no Android SDK/Gradle, so the APK itself must be built by GitHub Actions or Android Studio.

---

## ⬇️ Offline viewing & listening

| Method | Internet needed | How |
|---|---:|---|
| Record Live TV | While recording | Player → **⏺ Record** → Stop. Replay in Offline/USB. |
| Record Radio | While recording | Radio → station → **⏺ Record** (max 30 min). Replay in Offline/USB. |
| Download built-in movies | Once | Offline/USB → choose a movie card. |
| USB video/audio | Never | Copy files to flash disk → Offline/USB or Radio → **Choose file**. |
| DVB-T2 aerial | Never | TV aerial → Source **DTV/Antenna** → Auto Scan. This uses the TV tuner, separate from streaming apps. |
| Low-Data mode | Less data | Settings → **Low-Data ON** starts streams at the lowest quality. |

> A live internet stream cannot be received with no internet and no broadcast tuner. SAFI does not fake that; recordings, downloads, USB and DVB-T2 are the real zero-data routes.

---

## 🎮 Remote guide

| Remote / key | Action |
|---|---|
| ↑ ↓ ← → | Move focus |
| OK / Enter | Select; play/pause in player |
| Back / Esc | Back; exit player; press twice in APK to exit app |
| 0–9 | Type a TV channel number |
| CH+ / CH− | Next/previous TV channel or radio station |
| `F` | Add/remove favourite |
| `M` | Next source/mirror in player |
| `R` | Start/stop recording |
| Space | Play/pause |
| ← / → in player | Seek saved/movie media, or zap live |
| ↑ / ↓ in player | Volume (embedded player: zap) |

When a stream fails, SAFI now shows a guided **No signal** card explaining what was tried, the likely cause, and buttons for **Try Again, Next Source, Similar Working Channel, Channel Doctor, All Channels** or **TV Guide**. Use arrows + OK on that card. The player's **❔ Fix / Help** button opens the same guidance any time.

---

## ➕ Add your own playlist

1. Go to **Settings → Add your own IPTV playlist (M3U)**.
2. Paste an M3U URL you have the right to use, or upload an `.m3u` file.
3. Find it under **Live TV → My Playlist**.

Included exportable playlists:

- `playlists/safi_all_channels.m3u`
- `playlists/kenya.m3u`
- `playlists/radio.m3u`

---

## 📁 Folder guide

```text
smart-tv-box/
├── web/
│   ├── index.html
│   ├── css/tv.css
│   ├── assets/              Hero art
│   └── js/
│       ├── app.js           UI, Auto-Scan, Doctor, offline, player
│       ├── data.js          384 TV channels + 66 radio + Kenya directory
│       ├── world-data.js    Lazy-loaded World Directory (7,471)
│       └── hls.min.js
├── android-tv/              Android Studio project + native Booster
├── playlists/               TV, Kenya and radio M3U exports
├── server.py                Home server + media-only Booster (LAN only)
├── SECURITY.md              Security model + trusted-update rules
├── RELEASE_CHECKLIST.md     Final phone/laptop/TV release checks
├── sync-web.sh / .bat       Copy web UI into Android assets
├── .github/workflows/       Free APK build
└── README.md
```

---

## ❓ Troubleshooting

| Problem | What to do |
|---|---|
| “No signal on this channel” | Read the guided card. Try **Next Source**, run **Channel Doctor**, or choose **Similar Working Channel**. If it says **Not 24/7**, the broadcaster's encoder is off — no client can switch it on. |
| Pluto/CORS-style channel won't play in a browser | Use the APK, or run the app through `server.py`, so the ⚡ Booster is active. |
| Auto-Scan found 0 | Source may be temporarily unavailable, all first candidates may already exist, or candidates were dead/blocked. Try another scope or a larger limit. |
| Auto-Scan added a channel that later fails | Public streams change. Run **Channel Doctor**, use mirrors/Booster, or clear scanned additions and scan again. |
| Radio keeps buffering | Audio needs much less bandwidth than TV, but a weak/dead station server can still stall. Try its mirror with **🔁 Source**, another station, or ethernet/5 GHz Wi-Fi. |
| Recording empty/not supported | Some TVs/WebViews or non-CORS media block capture. Use USB audio/video or built-in movie downloads. Embedded stations cannot be recorded. |
| Citizen/NTV-type player says offline/upcoming | The station is not live on its embeddable feed at that moment. SAFI stays in-app rather than redirecting. Try its HLS sister station or another channel. |
| APK says “App not installed” | Uninstall an older SAFI TV+ first, allow unknown apps, check free storage, and use a fresh APK build. |
| Saved media disappeared | Recordings live in that browser/APK's device storage. Clearing app data or uninstalling deletes them. Keep important files on USB too. |

---

## 🔒 No-redirect enforcement

- The web UI contains no external-open actions and blocks stray anchor navigation.
- Embedded players use `sandbox="allow-scripts allow-same-origin allow-presentation"` — deliberately **no** `allow-popups` and **no** `allow-top-navigation`.
- Android blocks main-frame navigation away from the in-app origin, drops external schemes, refuses popup windows, and has no browser/app-launch code.
- Android's only `startActivityForResult` is the system file picker for user-chosen USB/M3U files; it returns the file to SAFI TV+ and opens no web page.
- Auto-Scan fetches data/media only. Search/source results are played in the SAFI player; station/source websites are never opened.

## ⚖️ Legal / content note

SAFI TV+ is a player and directory for home use. Built-in entries point to free publicly listed streams, official embeddable players, public radio streams and open movies. Broadcasters own their streams and may change, restrict or stop them at any time. Only add playlists/accounts you have the right to use, and record/download only where permitted for your own home use. Channel/station names and logos belong to their owners.

*SAFI TV+ v2.0.0 • Android Smart TV home use • Kenya 🇰🇪*
