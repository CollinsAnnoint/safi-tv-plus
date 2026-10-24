# Keep JavascriptInterface bridge used by the web UI
-keepclassmembers class ke.safitv.box.MainActivity$AndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
