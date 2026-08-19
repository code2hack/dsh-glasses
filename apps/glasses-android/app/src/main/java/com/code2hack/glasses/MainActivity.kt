package com.code2hack.glasses

import android.app.Activity
import android.os.Bundle
import android.os.Process
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * G0 glasses shell: one Activity, one dedicated WebView, a narrow bridge, and a
 * non-invasive raw input tracer. Debug variant only.
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var bridge: GlassesBridge
    private lateinit var sensorTracer: SensorTracer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        InputTracer.lifecycle("onCreate", "pid=${Process.myPid()}")

        bridge = GlassesBridge(applicationContext)
        sensorTracer = SensorTracer(applicationContext)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                InputTracer.lifecycle(
                    "webError",
                    "main=${request.isForMainFrame} code=${error.errorCode} description=${error.description}",
                )
                super.onReceivedError(view, request, error)
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(
                view: WebView,
                url: String?,
                message: String?,
                result: JsResult?,
            ): Boolean {
                InputTracer.lifecycle("jsAlert", "message=${message ?: ""}")
                result?.confirm()
                return true
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                InputTracer.lifecycle(
                    "jsConsole",
                    "level=${message.messageLevel()} line=${message.lineNumber()} source=${message.sourceId()} message=${message.message()}",
                )
                return true
            }
        }

        bridge.evaluate = { code -> webView.post { webView.evaluateJavascript(code, null) } }
        webView.addJavascriptInterface(bridge, GlassesBridge.jsName())

        InputTracer.onEvent = { line ->
            webView.post {
                webView.evaluateJavascript(
                    "window.onNativeTrace&&window.onNativeTrace(${JSONObject.quote(line)})",
                    null,
                )
            }
        }
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onResume() {
        super.onResume()
        InputTracer.lifecycle("onResume")
        if (::sensorTracer.isInitialized) sensorTracer.start()
    }

    override fun onPause() {
        if (::sensorTracer.isInitialized) sensorTracer.stop()
        InputTracer.lifecycle("onPause")
        super.onPause()
    }

    override fun onStop() {
        InputTracer.lifecycle("onStop")
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        InputTracer.lifecycle("windowFocus", "hasFocus=$hasFocus")
    }

    override fun onUserLeaveHint() {
        InputTracer.lifecycle("onUserLeaveHint")
        super.onUserLeaveHint()
    }

    override fun onDestroy() {
        InputTracer.lifecycle("onDestroy")
        InputTracer.onEvent = null
        if (::sensorTracer.isInitialized) sensorTracer.stop()
        if (::bridge.isInitialized) bridge.close()
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.removeJavascriptInterface(GlassesBridge.jsName())
            webView.destroy()
        }
        super.onDestroy()
    }

    // Trace first, then delegate to Android. Returning the tracer's result would
    // bypass normal Activity/View dispatch and invalidate the hardware evidence.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        InputTracer.key("DISPATCH_KEY", event)
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (event != null) InputTracer.key("ON_KEY_DOWN", event)
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (event != null) InputTracer.key("ON_KEY_UP", event)
        return super.onKeyUp(keyCode, event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        InputTracer.motion("DISPATCH_TOUCH", event)
        return super.dispatchTouchEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        InputTracer.motion("DISPATCH_GENERIC_MOTION", event)
        return super.dispatchGenericMotionEvent(event)
    }
}
