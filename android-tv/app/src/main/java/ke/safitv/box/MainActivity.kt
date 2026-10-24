package ke.safitv.box

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * SAFI TV+ — Android TV / Smart Box app (v2.0, NO-REDIRECT edition)
 *
 * The TV interface lives in assets/www (copied from ../../web) and is served
 * over a secure in-app origin via WebViewAssetLoader:
 *     https://appassets.androidplatform.net/assets/www/index.html
 * (a real https origin is required for embedded live players to work reliably).
 *
 * NO-REDIRECT GUARANTEES enforced here at the native level:
 *  1. Top-level navigation to any outside http(s) URL is BLOCKED.
 *  2. intent://, market://, tel:, mailto: etc. are DROPPED (never launched).
 *  3. Script popups cannot create a new window (onCreateWindow = false).
 *  4. There is NO code in this file that starts a browser or another app.
 *     (No external-view intents, no package launchers — grep to verify.)
 * Video/HLS segment requests and in-player embedded live players are
 * sub-resource/iframe loads, not navigations, so playback works inside the app.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var root: FrameLayout
    private var backPressedAt = 0L
    @Volatile private var jsAtHome = true
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        const val APP_HOST = "appassets.androidplatform.net"
        const val APP_URL = "https://$APP_HOST/assets/www/index.html"
        const val FILE_CHOOSER_REQUEST = 1001
    }

    /** Only native capabilities exposed to JS: a small message + Booster state. Nothing can leave the app. */
    inner class AndroidBridge {
        @JavascriptInterface
        fun boosterEnabled(): Boolean = true

        @JavascriptInterface
        fun setAtHome(atHome: Boolean) {
            jsAtHome = atHome
        }

        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finishAndRemoveTask() }
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Remote WebView debugging only in debuggable developer builds, never release.
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            isFocusable = true
            isFocusableInTouchMode = true
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true // required for app preferences/offline metadata
                databaseEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
                saveFormData = false
                savePassword = false
                setGeolocationEnabled(false)
                mediaPlaybackRequiresUserGesture = false
                loadWithOverviewMode = true
                useWideViewPort = true
                builtInZoomControls = false
                displayZoomControls = false
                setSupportMultipleWindows(false)          // no popups / new windows
                javaScriptCanOpenWindowsAutomatically = false
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW // allow http streams
                userAgentString = userAgentString + " SAFITV-AndroidTV/2.0"
            }
            addJavascriptInterface(AndroidBridge(), "AndroidTV")
            webViewClient = object : WebViewClient() {

                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? {
                    assetLoader.shouldInterceptRequest(request.url)?.let { return it }
                    // ⚡ Native Stream Booster: repairs HLS streams that a WebView
                    // would block (CORS / referrer rules) by fetching them natively.
                    if (isStreamUrl(request.url)) {
                        boosterFetch(request)?.let { return it }
                    }
                    return null
                }

                /** Block every attempt to navigate the whole app somewhere else. */
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val url = req.url
                    // Our own app pages: allow
                    if (url.host == APP_HOST) return false
                    // Iframe/subframe loads (embedded in-player live feeds): allow (not a redirect of the app)
                    if (!req.isForMainFrame) return false
                    // Everything else trying to take over the screen: BLOCK and stay in SAFI TV+
                    if (req.isRedirect || req.hasGesture() || true) {
                        runOnUiThread {
                            Toast.makeText(
                                this@MainActivity,
                                "🔒 Blocked — SAFI TV+ never redirects you outside the app",
                                Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                    return true // handled = do not load it anywhere
                }
            }
            webChromeClient = object : WebChromeClient() {
                // Refuse to create popup windows (e.g. "Watch on YouTube" new-tab attempts)
                override fun onCreateWindow(
                    view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?
                ): Boolean = false

                // System file picker for the in-app "Choose file" buttons only
                // (USB videos + .m3u playlists). It returns to SAFI TV+ with the
                // picked file; it is not a browser/app redirect and opens no web page.
                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams
                ): Boolean {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = filePathCallback
                    return try {
                        val intent = fileChooserParams.createIntent()
                        startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                        true
                    } catch (e: Exception) {
                        this@MainActivity.filePathCallback = null
                        Toast.makeText(this@MainActivity, "No file manager found on this TV", Toast.LENGTH_LONG).show()
                        false
                    }
                }

                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    customView = view; customCallback = callback
                    root.addView(view, FrameLayout.LayoutParams(-1, -1))
                    webView.visibility = View.GONE
                }
                override fun onHideCustomView() {
                    customView?.let { root.removeView(it) }
                    customView = null; webView.visibility = View.VISIBLE
                    customCallback?.onCustomViewHidden()
                }
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        webView.requestFocus()
        webView.loadUrl(APP_URL)
    }

    /* ================= ⚡ Native Stream Booster (v2.0) =================
       Many legitimate free streams (e.g. Pluto/Rakuten-style FAST channels)
       serve playlists whose CORS/referrer rules block WebView playback,
       even though the streams themselves are public. The booster fetches
       HLS playlists + segments natively (browser-like headers, cookies,
       redirects followed), rewrites playlist URLs to absolute ones and
       returns them to the player with open CORS — so the channel plays
       INSIDE SAFI TV+. Only stream file names are handled; web pages are
       never proxied or navigated. Runs on a background thread (WebView
       calls shouldInterceptRequest off the UI thread). */
    private fun isStreamUrl(url: Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        if (url.host == APP_HOST) return false
        val path = (url.path ?: "").lowercase()
        val full = url.toString().lowercase()
        return full.contains(".m3u8") ||
            path.endsWith(".ts") || path.endsWith(".m4s") ||
            path.endsWith(".cmfv") || path.endsWith(".cmfa") || path.endsWith(".aac") ||
            path.endsWith(".mp3") || path.endsWith(".m4a") || path.endsWith(".ogg") ||
            path.endsWith(".opus") || path.endsWith(".flac")
    }

    private fun boosterFetch(request: WebResourceRequest): WebResourceResponse? {
        val cors = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Headers" to "Range, Origin, Accept, Content-Type",
            "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
            "Access-Control-Expose-Headers" to "Content-Length, Content-Range"
        )
        if (request.method.equals("OPTIONS", ignoreCase = true)) {
            return WebResourceResponse("text/plain", null, ByteArrayInputStream(ByteArray(0))).apply {
                responseHeaders = cors
                setStatusCodeAndReasonPhrase(200, "OK")
            }
        }
        return try {
            val url = URL(request.url.toString())
            val conn = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = true
                connectTimeout = 12000
                readTimeout = 25000
                requestMethod = if (request.method.equals("HEAD", true)) "HEAD" else "GET"
                setRequestProperty(
                    "User-Agent",
                    "Mozilla/5.0 (SMART-TV; Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                )
                setRequestProperty("Accept", "*/*")
                val host = url.host
                if (!host.isNullOrEmpty()) setRequestProperty("Referer", "${url.protocol}://$host/")
                request.requestHeaders["Range"]?.let { setRequestProperty("Range", it) }
                try {
                    CookieManager.getInstance().getCookie(request.url.toString())
                        ?.let { setRequestProperty("Cookie", it) }
                } catch (e: Exception) { /* cookies best-effort */ }
            }
            val code = conn.responseCode
            if (code !in 200..299) return null // let the WebView/player handle the error
            try {
                val cm = CookieManager.getInstance()
                conn.headerFields["Set-Cookie"]?.forEach { cm.setCookie(request.url.toString(), it) }
                conn.headerFields["Set-Cookie2"]?.forEach { cm.setCookie(request.url.toString(), it) }
            } catch (e: Exception) { /* ignore */ }

            val finalUrl: URL = conn.url
            val isPlaylist = finalUrl.toString().lowercase().contains(".m3u8") ||
                (conn.contentType ?: "").lowercase().contains("mpegurl")
            if (isPlaylist) {
                val body = conn.inputStream.readBytes().toString(Charsets.UTF_8)
                if (!body.contains("#EXTM3U")) return null
                val rewritten = rewritePlaylist(body, finalUrl)
                WebResourceResponse(
                    "application/vnd.apple.mpegurl", "utf-8",
                    ByteArrayInputStream(rewritten.toByteArray(Charsets.UTF_8))
                ).apply {
                    responseHeaders = cors + mapOf("Cache-Control" to "no-cache")
                    setStatusCodeAndReasonPhrase(200, "OK")
                }
            } else {
                val ct = (conn.contentType ?: "application/octet-stream").substringBefore(";").trim()
                val headers = cors.toMutableMap()
                conn.getHeaderField("Content-Length")?.let { headers["Content-Length"] = it }
                conn.getHeaderField("Content-Range")?.let { headers["Content-Range"] = it }
                headers["Accept-Ranges"] = "bytes"
                WebResourceResponse(ct, null, conn.inputStream).apply {
                    responseHeaders = headers
                    if (code == 206) setStatusCodeAndReasonPhrase(206, "Partial Content")
                    else setStatusCodeAndReasonPhrase(200, "OK")
                }
            }
        } catch (e: Exception) {
            null // never break playback: fall back to the normal WebView load
        }
    }

    private fun rewritePlaylist(body: String, base: URL): String {
        val uriRe = Regex("""URI="([^"]+)"""")
        val out = StringBuilder()
        for (raw in body.split("\n")) {
            val line = raw.trim()
            when {
                line.isEmpty() -> out.append('\n')
                line.startsWith("#") -> out.append(
                    uriRe.replace(line) { m -> "URI=\"" + URL(base, m.groupValues[1]).toString() + "\"" }
                ).append('\n')
                else -> out.append(URL(base, line).toString()).append('\n')
            }
        }
        return out.toString()
    }

    private fun sendEscapeToApp() {
        webView.evaluateJavascript(
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));", null
        )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (customView != null) { hideCustomView(); return true }
            // First let SAFI close the player or step to the Previous screen.
            sendEscapeToApp()
            if (!jsAtHome) {
                backPressedAt = 0L
                return true
            }
            val now = System.currentTimeMillis()
            if (now - backPressedAt < 2000) { finishAndRemoveTask() } else {
                backPressedAt = now
                Handler(Looper.getMainLooper()).postDelayed({
                    Toast.makeText(this, "Press Back again to exit SAFI TV+", Toast.LENGTH_SHORT).show()
                }, 350)
            }
            return true
        }
        // Channel up/down on TV remotes -> events understood by the web player
        if (keyCode == KeyEvent.KEYCODE_CHANNEL_UP) {
            webView.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ChannelUp',bubbles:true}));", null)
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_CHANNEL_DOWN) {
            webView.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ChannelDown',bubbles:true}));", null)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun hideCustomView() {
        customView?.let { root.removeView(it) }
        customView = null; webView.visibility = View.VISIBLE
        customCallback?.onCustomViewHidden()
        sendEscapeToApp()
    }

    @Deprecated("File chooser result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST) {
            filePathCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            )
            filePathCallback = null
        }
    }

    override fun onPause() { super.onPause(); webView.onPause() }
    override fun onResume() { super.onResume(); webView.onResume(); webView.requestFocus() }
    override fun onDestroy() { webView.destroy(); super.onDestroy() }
}
