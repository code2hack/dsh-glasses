package com.code2hack.glasses

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Narrow origin-restricted native bridge for G0. The WebView never sees the raw
 * bearer credential: it lives in app-private storage and is attached natively.
 *
 * JS surface (registered as `GlassesBridge`):
 *   bridge.configure(base, token, sessionId)  dev provisioning -> app-private prefs
 *   bridge.endpoint()                          configured base (no secrets)
 *   bridge.fetch(path, bodyJson)               authenticated one-shot fetch; JSON {status, body}
 *   bridge.openStream()                        authenticated SSE; lines -> window.glassesOnLine,
 *                                              state -> window.glassesOnStream(state, detail)
 */
class GlassesBridge(private val context: Context) {
    companion object {
        private const val TAG = "DSHGlassesBridge"
        private const val NAME = "GlassesBridge"
        private const val PREFS = "glasses_private"
        private const val KEY_BASE = "base"
        private const val KEY_TOKEN = "token"
        private const val KEY_SESSION = "session"
        fun jsName() = NAME
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val scope = CoroutineScope(Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())

    var evaluate: ((String) -> Unit)? = null // wired by the host to WebView.evaluateJavascript

    private fun base(): String = prefs.getString(KEY_BASE, null) ?: ""
    private fun token(): String = prefs.getString(KEY_TOKEN, null) ?: ""
    private fun session(): String = prefs.getString(KEY_SESSION, null) ?: ""

    @JavascriptInterface
    fun endpoint(): String = base()

    @JavascriptInterface
    fun sessionId(): String = session()

    @JavascriptInterface
    fun configure(base: String, token: String, sessionId: String) {
        prefs.edit().putString(KEY_BASE, base.trimEnd('/')).putString(KEY_TOKEN, token).putString(KEY_SESSION, sessionId).apply()
        Log.i(TAG, "configured base=$base session=${sessionId.take(12)}…")
    }

    @JavascriptInterface
    fun fetch(path: String, bodyJson: String): String {
        Log.i(TAG, "fetch $path")
        try {
            val url = URL(base() + path)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = if (bodyJson.isNotEmpty() && bodyJson != "null") "POST" else "GET"
                connectTimeout = 8000
                readTimeout = 20000
                setRequestProperty("Authorization", "Bearer ${token()}")
                setRequestProperty("Accept", "application/json")
                if (requestMethod == "POST") {
                    doOutput = true
                    outputStream.write(bodyJson.toByteArray(StandardCharsets.UTF_8))
                }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            return JSONObject().put("status", status).put("body", body).toString()
        } catch (e: Exception) {
            Log.w(TAG, "fetch failed", e)
            return JSONObject().put("status", 0).put("body", String(e.message ?: "network-error")).toString()
        }
    }

    @JavascriptInterface
    fun openStream() {
        scope.launch {
            try {
                val url = URL(base() + "/glasses/v1/stream")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 8000
                    readTimeout = 0 // streaming
                    setRequestProperty("Authorization", "Bearer ${token()}")
                    setRequestProperty("Accept", "text/event-stream")
                    setRequestProperty("Cache-Control", "no-cache, no-transform")
                }
                val status = conn.responseCode
                if (status != 200) {
                    jsEval("window.glassesOnStream&&window.glassesOnStream('error','HTTP $status')")
                    conn.disconnect()
                    return@launch
                }
                jsEval("window.glassesOnStream&&window.glassesOnStream('open',null)")
                var body: String? = ""
                var event: String? = null
                val reader = BufferedReader(InputStreamReader(conn.inputStream, StandardCharsets.UTF_8))
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    if (line.startsWith("event:")) { event = line.substring(6).trim(); continue }
                    if (line.startsWith("data:")) {
                        body = line.substring(5).trim()
                        val ev = event ?: ""
                        jsEval("window.glassesOnLine&&window.glassesOnLine(${jsQ(ev)},${jsQ(body ?: "")})")
                    }
                }
                reader.close()
                conn.disconnect()
                jsEval("window.glassesOnStream&&window.glassesOnStream('closed',null)")
            } catch (e: Exception) {
                Log.w(TAG, "stream failed", e)
                jsEval("window.glassesOnStream&&window.glassesOnStream('error',${jsQ(e.message ?: "stream-error")})")
            }
        }
    }

    private fun jsEval(code: String) = main.post { evaluate?.invoke(code) }

    private fun jsQ(s: String): String {
        val q = s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        return "'$q'"
    }
}
