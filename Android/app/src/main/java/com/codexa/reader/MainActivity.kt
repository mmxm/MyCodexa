package com.codexa.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /** Set to true by the JS bridge when the reader activates volume-key navigation. */
    @Volatile
    private var volumeKeyModeEnabled = false

    // Track back-press timing: second back press within 2 s opens server select
    private var lastBackPressTime = 0L

    // Launcher for ServerSelectActivity — handles both first-run and change-server flows
    private val serverSelectLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val url = result.data?.getStringExtra(ServerSelectActivity.RESULT_URL) ?: return@registerForActivityResult
            saveUrl(url)
            webView.loadUrl(url)
        } else if (getSavedUrl() == null) {
            // First run and user somehow cancelled — show it again (non-cancellable)
            openServerSelect(cancellable = false)
        }
    }

    // -------------------------------------------------------------------------
    // <input type="file"> support. Without onShowFileChooser() + this launcher,
    // the WebView silently drops every file pick (book / font / dictionary upload).
    // -------------------------------------------------------------------------
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        // parseResult handles cancel (returns null) and multi-select via clipData.
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        fileChooserCallback?.onReceiveValue(uris)
        fileChooserCallback = null
    }

    // -------------------------------------------------------------------------
    // JS bridge — exposed to JavaScript as window.AndroidCodexa
    // -------------------------------------------------------------------------
    inner class JsBridge {

        /** Called by the web reader to enable or disable volume-key page navigation. */
        @JavascriptInterface
        fun setVolumeKeyMode(enabled: Boolean) {
            volumeKeyModeEnabled = enabled
        }

        /** Returns the app version string so the web side can gate features. */
        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.VERSION_NAME

        /** Can be called from web JS to open the change-server screen. */
        @JavascriptInterface
        fun changeServer() {
            runOnUiThread { openServerSelect(cancellable = true) }
        }

        /** Called by the reader JS to enter/exit fullscreen immersive mode (hide nav bar). */
        @JavascriptInterface
        fun setReaderMode(active: Boolean) {
            runOnUiThread { setImmersiveMode(active) }
        }

        /** Lock or unlock the screen orientation to portrait. */
        @JavascriptInterface
        fun setPortraitLock(lock: Boolean) {
            runOnUiThread {
                requestedOrientation = if (lock)
                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                else
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }

        /** Returns true when the user enabled e-ink mode in the server-select screen. */
        @JavascriptInterface
        fun isEinkMode(): Boolean =
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("eink_mode", false)

        /** Returns true when the Android system is in night/dark mode. */
        @JavascriptInterface
        fun isNightMode(): Boolean {
            val uiMode = resources.configuration.uiMode and
                    android.content.res.Configuration.UI_MODE_NIGHT_MASK
            return uiMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
        }

        /** Persists e-ink mode so the login-page toggle stays in sync with server-select. */
        @JavascriptInterface
        fun setEinkMode(enabled: Boolean) {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("eink_mode", enabled).apply()
        }

        /**
         * Called by web JS whenever it applies/resolves a theme, so the system status bar
         * and navigation bar icon color can be flipped to match. The WebView content's theme
         * (day/night/eink/sepia/...) is decided entirely in CSS/JS and the native shell has no
         * other way to learn it — without this, system bar icons stay whatever color they
         * defaulted to (independent of the in-app theme) and can become invisible against it
         * (e.g. light system icons on a bright in-app background).
         */
        @JavascriptInterface
        fun setStatusBarAppearance(light: Boolean) {
            runOnUiThread {
                val controller = WindowInsetsControllerCompat(window, window.decorView)
                controller.isAppearanceLightStatusBars = light
                controller.isAppearanceLightNavigationBars = light
            }
        }
    }

    // -------------------------------------------------------------------------
    // Activity lifecycle
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Stay edge-to-edge for the entire lifetime of the activity.
        // We never re-enable fitSystemWindows because toggling it causes
        // a layout jump (blank gap below the status bar) when leaving the reader.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)

        onBackPressedDispatcher.addCallback(this, onBackCallback)

        configureWebView()

        val savedUrl = getSavedUrl()
        if (savedUrl != null) {
            webView.loadUrl(savedUrl)
        } else {
            openServerSelect(cancellable = false)
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        registerNetworkCallback()
        // Trigger sync in case device was offline while sleeping and is now connected
        if (isOnReader()) triggerNetworkRestoreSync()
    }

    override fun onPause() {
        super.onPause()
        // Pause the WebView so its JS timers (clock / battery refresh, etc.) stop while the
        // app is backgrounded — saves power on e-ink devices when the cover is closed.
        webView.onPause()
        unregisterNetworkCallback()
    }

    override fun onDestroy() {
        // Detach and destroy the WebView to release its resources and avoid leaks.
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // The system can re-show the status/nav bars on its own whenever this window regains
    // focus (backgrounding via home button / recents / notification shade / a system dialog,
    // then returning) — hiding them once in onPageStarted/onPageFinished isn't enough to keep
    // them hidden across that. Reasserting here on every focus-regain is the documented fix
    // for immersive mode "not sticking" after the app comes back from the background.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            setImmersiveMode(isOnReader())
        }
    }

    // -------------------------------------------------------------------------
    // Network callback — triggers KOSync when connectivity is restored
    // -------------------------------------------------------------------------

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private fun registerNetworkCallback() {
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Small delay to let the network fully settle before making API calls
                webView.postDelayed({ if (isOnReader()) triggerNetworkRestoreSync() }, 2000)
            }
        }
        connectivityManager?.registerNetworkCallback(request, networkCallback!!)
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        networkCallback = null
    }

    private fun isOnReader(): Boolean =
        webView.url?.contains("/reader.html", ignoreCase = true) == true

    private fun triggerNetworkRestoreSync() {
        runOnUiThread {
            webView.evaluateJavascript(
                "if(typeof window.__codexaNetworkRestore==='function') window.__codexaNetworkRestore();",
                null
            )
        }
    }

    // Physical back behaviour (via OnBackPressedDispatcher / predictive back):
    //   - Blocked entirely when the reader is open (use the in-reader UI to exit)
    //   - Double-press anywhere else: first press shows hint toast,
    //     second press within 2 s opens server select screen.
    //   WebView history is intentionally never navigated via the hardware back key,
    //   so the callback stays enabled at all times to consume the gesture.
    private val onBackCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val currentUrl = webView.url ?: ""
            if (currentUrl.contains("/reader.html", ignoreCase = true)) {
                return
            }
            val now = System.currentTimeMillis()
            if (now - lastBackPressTime < 2000) {
                openServerSelect(cancellable = true)
            } else {
                lastBackPressTime = now
                Toast.makeText(this@MainActivity, getString(R.string.back_press_hint), Toast.LENGTH_SHORT).show()
            }
        }
    }

    // -------------------------------------------------------------------------
    // Volume key interception
    // -------------------------------------------------------------------------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!volumeKeyModeEnabled) return super.dispatchKeyEvent(event)

        val action = event.action
        val code = event.keyCode

        if (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP) {
            if (action == KeyEvent.ACTION_UP) {
                val direction = if (code == KeyEvent.KEYCODE_VOLUME_DOWN) "down" else "up"
                webView.evaluateJavascript(
                    "if(typeof window.__codexaVolumeKey==='function') window.__codexaVolumeKey('$direction');",
                    null
                )
            }
            return true
        }

        return super.dispatchKeyEvent(event)
    }

    // -------------------------------------------------------------------------
    // WebView configuration
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString CodexaApp/${BuildConfig.VERSION_NAME}"
        }

        webView.addJavascriptInterface(JsBridge(), "AndroidCodexa")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // Cancel any previous pending pick so its <input> isn't left hanging.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback

                val baseIntent = fileChooserParams?.createIntent()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "*/*"
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }

                // Wrap with createChooser so the system picker always appears even when
                // the specific MIME types (epub, cbz, ttf…) aren't registered on the device.
                // Without this, ACTION_GET_CONTENT can silently resolve to nothing on some
                // Android 10+ devices / OEM launchers, giving the appearance that the tap
                // did nothing at all.
                val chooserIntent = Intent.createChooser(baseIntent, null)

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (e: Exception) {
                    // Catch SecurityException / IllegalStateException in addition to
                    // ActivityNotFoundException — all leave the callback in a hung state
                    // on modern Android if not cleaned up here.
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = null
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.file_chooser_unavailable),
                        Toast.LENGTH_SHORT
                    ).show()
                    false
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url.toString()
                if (url.startsWith("mailto:") || url.startsWith("tel:")) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    return true
                }
                // Any navigation to a host other than the configured Codexa server
                // (e.g. a "View on BookOrbit" link) should open in the system browser
                // instead of loading inside this app's WebView.
                val serverHost = getSavedUrl()?.let { Uri.parse(it).host }
                val targetHost = request.url.host
                if (serverHost != null && targetHost != null && !targetHost.equals(serverHost, ignoreCase = true)) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (e: Exception) {
                        // No browser available — fall through and let the WebView try.
                        return false
                    }
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                volumeKeyModeEnabled = false
                // Exit immersive mode when navigating away from reader
                val isReader = url.contains("/reader.html", ignoreCase = true)
                runOnUiThread { setImmersiveMode(isReader) }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                val isReader = url.contains("/reader.html", ignoreCase = true)
                runOnUiThread {
                    setImmersiveMode(isReader)
                    // Inject status bar height as --sat so older Chrome WebViews
                    // (< 87, where env(safe-area-inset-top) returns 0) still get
                    // the correct top padding. getRootWindowInsets does NOT replace
                    // WebView's internal inset listener, so env() keeps working on
                    // modern Chrome where it is already supported.
                    if (!isReader) {
                        val rootInsets = ViewCompat.getRootWindowInsets(view)
                        if (rootInsets != null) {
                            val density = resources.displayMetrics.density
                            val combined = WindowInsetsCompat.Type.statusBars() or
                                    WindowInsetsCompat.Type.displayCutout()
                            val topPx = rootInsets.getInsets(combined).top
                            if (topPx > 0) {
                                val cssVal = String.format(java.util.Locale.ROOT, "%.2f", topPx / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sat','${cssVal}px');",
                                    null
                                )
                            }
                            val nav = rootInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
                            if (nav.bottom > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.bottom / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sab','${v}px');", null)
                            }
                            if (nav.left > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.left / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sal','${v}px');", null)
                            }
                            if (nav.right > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.right / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sar','${v}px');", null)
                            }
                        }
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Immersive mode (hide system navigation bar in reader)
    // -------------------------------------------------------------------------

    private fun setImmersiveMode(enable: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (enable) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    // -------------------------------------------------------------------------
    // Server URL management
    // -------------------------------------------------------------------------

    private fun openServerSelect(cancellable: Boolean) {
        val intent = Intent(this, ServerSelectActivity::class.java).apply {
            putExtra(ServerSelectActivity.EXTRA_INITIAL_URL, getSavedUrl() ?: "")
            putExtra("cancellable", cancellable)
        }
        serverSelectLauncher.launch(intent)
    }

    private fun getSavedUrl(): String? =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(PREF_URL, null)

    private fun saveUrl(url: String) =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_URL, url)
            .apply()

    companion object {
        private const val PREFS_NAME = "codexa_prefs"
        private const val PREF_URL   = "server_url"
    }
}
