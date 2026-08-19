package com.code2hack.glasses

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JsResult
import android.webkit.WebChromeClient

/**
 * G0 glasses shell: one Activity, one dedicated WebView, a narrow bridge, and a
 * raw input tracer. Debug variant only; native logs under DSHGlasses.
 *
 * The native shell owns lifecycle, HUD wake, WebView config, creds storage,
 * origin-restricted bridge, and input capture. The WebView owns bootstrap /
 * SSE / one-session projection / reconnect indicator.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "DSHGlasses"
    }

    private lateinit var webView: WebView
    private lateinit var bridge: GlassesBridge

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        Log.i(TAG, "lifecycle onCreate pid=${android.os.Process.myPid()}")

        bridge = GlassesBridge(applicationContext)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.setWebViewClient(object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true // no external nav
        })
        webView.setWebChromeClient(object : WebChromeClient() {
            override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult?): Boolean {
                Log.i(TAG, "jsAlert $message")
                result?.confirm()
                return true
            }
        })

        bridge.evaluate = { code -> webView.post { webView.evaluateJavascript(code, null) } }
        webView.addJavascriptInterface(bridge, GlassesBridge.jsName())
        webView.loadUrl("file:///android_asset/index.html")

        // Forward every raw native interaction to the tracer (which logs + feeds JS).
        InputTracer.onEvent = { line -> webView.post { webView.evaluateJavascript("window.onNativeTrace(${qs(line)})", null) } }
    }

    override fun onResume() { super.onResume(); Log.i(TAG, "lifecycle onResume") }
    override fun onPause() { Log.i(TAG, "lifecycle onPause"); super.onPause() }
    override fun onStop() { Log.i(TAG, "lifecycle onStop"); super.onStop() }
    override fun onDestroy() { Log.i(TAG, "lifecycle onDestroy"); super.onDestroy() }

    // ---- raw input capture (native shell owns it; never a product transport) ----

    override fun dispatchKeyEvent(event: KeyEvent): Boolean = InputTracer.key("KEY", event, nativeVisible(event))
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean = InputTracer.key("KEY_DOWN", event ?: return super.onKeyDown(keyCode, event), nativeVisible(event))
    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean = InputTracer.key("KEY_UP", event ?: return super.onKeyUp(keyCode, event), nativeVisible(event))
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean = InputTracer.motion("TOUCH", ev, false) || super.dispatchTouchEvent(ev)
    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean = InputTracer.motion("MOTION", ev, false) || super.dispatchGenericMotionEvent(ev)

    private fun nativeVisible(event: KeyEvent?): Boolean {
        if (event == null) return false
        // Empiric: a KeyEvent reaching us unchanged usually means the OS did not
        // swallow it for a native Rokid operation. Keep as observed evidence only.
        return true
    }

    private fun qs(s: String): String = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"
}
