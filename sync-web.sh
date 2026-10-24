#!/bin/bash
# Copy the latest web TV interface into the Android app (run before rebuilding the APK)
set -e
cd "$(dirname "$0")"
rm -rf android-tv/app/src/main/assets/www
mkdir -p android-tv/app/src/main/assets/www
cp -r web/index.html web/sw.js web/css web/js web/assets android-tv/app/src/main/assets/www/
echo "✅ Web UI synced into android-tv/ — now rebuild the APK in Android Studio (Build > Build APKs)."
