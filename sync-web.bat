@echo off
REM Copy the latest web TV interface into the Android app (run before rebuilding the APK)
cd /d "%~dp0"
rmdir /s /q android-tv\app\src\main\assets\www 2>nul
mkdir android-tv\app\src\main\assets\www
copy /y web\index.html android-tv\app\src\main\assets\www\ >nul
copy /y web\sw.js android-tv\app\src\main\assets\www\ >nul
xcopy /e /i /y web\css android-tv\app\src\main\assets\www\css >nul
xcopy /e /i /y web\js android-tv\app\src\main\assets\www\js >nul
xcopy /e /i /y web\assets android-tv\app\src\main\assets\www\assets >nul
echo Done. Now rebuild the APK in Android Studio (Build - Build APKs).
pause
