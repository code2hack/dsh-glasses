package com.code2hack.glasses

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * Narrow native bridge for G0. The asset WebView never receives the bearer
 * credential: it stays in app-private storage and is attached natively.
 *
 * JS surface (registered as `GlassesBridge`):
 *   configure(base, token, sessionId)  debug provisioning -> private prefs
 *   endpoint()                         configured base, never a credential
 *   sessionId()                        expected configured DSH session
 *   fetch(path, bodyJson)              authenticated /glasses/v1/* request
 *   openStream()                       one authenticated SSE connection
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
    private val main = Handler(Looper.getMainLooper())
    private val network = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "dsh-glasses-network").apply { isDaemon = true }
    }

    @Volatile private var streamConnection: HttpURLConnection? = null
    @Volatile private var streamTask: Future<*>? = null
    @Volatile private var closed = false

    var evaluate: ((String) -> Unit)? = null

    private fun base(): String = prefs.getString(KEY_BASE, null) ?: ""
    private fun token(): String = prefs.getString(KEY_TOKEN, null) ?: ""
    private fun session(): String = prefs.getString(KEY_SESSION, null) ?: ""

    @JavascriptInterface
    fun endpoint(): String = base()

    @JavascriptInterface
    fun sessionId(): String = session()

    @JavascriptInterface
    fun configure(base: String, token: String, sessionId: String) {
        val normalized = base.trim().trimEnd('/')
        if (!(normalized.startsWith("http://") || normalized.startsWith("https://"))) {
            Log.w(TAG, "refused non-http endpoint")
            return
        }
        prefs.edit()
            .putString(KEY_BASE, normalized)
            .putString(KEY_TOKEN, token)
            .putString(KEY_SESSION, sessionId)
            .apply()
        Log.i(TAG, "configured endpoint=$normalized session=${sessionId.take(12)}…")
    }

    @JavascriptInterface
    fun fetch(path: String, bodyJson: String): String {
        if (!allowedPath(path)) {
            Log.w(TAG, "refused path=$path")
            return jsonResult(403, "forbidden-native-path")
        }
        val endpoint = base()
        val credential = token()
        if (endpoint.isEmpty() || credential.isEmpty()) return jsonResult(0, "not-configured")

        Log.i(TAG, "fetch path=$path")
        var conn: HttpURLConnection? = null
        return try {
            val connection = (URL(endpoint + path).openConnection() as HttpURLConnection).apply {
                requestMethod = if (bodyJson.isNotEmpty() && bodyJson != "null") "POST" else "GET"
                connectTimeout = 8_000
                readTimeout = 20_000
                instanceFollowRedirects = false
                setRequestProperty("Authorization", "Bearer $credential")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Accept-Encoding", "identity")
                if (requestMethod == "POST") {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    outputStream.use { it.write(bodyJson.toByteArray(StandardCharsets.UTF_8)) }
                }
            }
            conn = connection
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            JSONObject().put("status", status).put("body", body).toString()
        } catch (e: Exception) {
            Log.w(TAG, "fetch failed path=$path", e)
            jsonResult(0, e.message ?: "network-error")
        } finally {
            conn?.disconnect()
        }
    }

    @JavascriptInterface
    @Synchronized
    fun openStream() {
        if (closed) return
        streamConnection?.disconnect()
        streamTask?.cancel(true)
        streamTask = network.submit { runStream() }
    }

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        streamConnection?.disconnect()
        streamTask?.cancel(true)
        network.shutdownNow()
        evaluate = null
    }

    private fun runStream() {
        val endpoint = base()
        val credential = token()
        if (endpoint.isEmpty() || credential.isEmpty()) {
            jsStream("error", "not-configured")
            return
        }

        var conn: HttpURLConnection? = null
        var opened = false
        try {
            val connection = (URL(endpoint + "/glasses/v1/stream").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8_000
                readTimeout = 0
                instanceFollowRedirects = false
                setRequestProperty("Authorization", "Bearer $credential")
                setRequestProperty("Accept", "text/event-stream")
                setRequestProperty("Accept-Encoding", "identity")
                setRequestProperty("Cache-Control", "no-cache, no-transform")
            }
            conn = connection
            streamConnection = connection
            val status = connection.responseCode
            if (status != 200) {
                jsStream("error", "HTTP $status")
                return
            }

            opened = true
            jsStream("open", null)
            parseSse(BufferedReader(InputStreamReader(connection.inputStream, StandardCharsets.UTF_8)))
        } catch (e: Exception) {
            val stillCurrent = streamConnection === conn
            if (!closed && stillCurrent && !Thread.currentThread().isInterrupted) {
                Log.w(TAG, "stream failed", e)
                jsStream("error", e.message ?: "stream-error")
            }
        } finally {
            val stillCurrent = streamConnection === conn
            if (stillCurrent) streamConnection = null
            conn?.disconnect()
            if (opened && !closed && stillCurrent && !Thread.currentThread().isInterrupted) {
                jsStream("closed", null)
            }
        }
    }

    private fun parseSse(reader: BufferedReader) {
        reader.use {
            var eventName = "message"
            var eventId = ""
            val data = StringBuilder()

            fun dispatch() {
                if (data.isNotEmpty()) {
                    jsEval(
                        "window.glassesOnLine&&window.glassesOnLine(" +
                            "${jsQ(eventName)},${jsQ(data.toString())},${jsQ(eventId)})"
                    )
                }
                eventName = "message"
                eventId = ""
                data.setLength(0)
            }

            while (!closed && !Thread.currentThread().isInterrupted) {
                val line = reader.readLine() ?: break
                when {
                    line.isEmpty() -> dispatch()
                    line.startsWith(":") -> Unit
                    line.startsWith("event:") -> eventName = line.substring(6).trimStart()
                    line.startsWith("id:") -> eventId = line.substring(3).trimStart()
                    line.startsWith("data:") -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.substring(5).trimStart())
                    }
                }
            }
            dispatch()
        }
    }

    private fun allowedPath(path: String): Boolean =
        path == "/glasses/v1" || path.startsWith("/glasses/v1/")

    private fun jsonResult(status: Int, body: String): String =
        JSONObject().put("status", status).put("body", body).toString()

    private fun jsStream(state: String, detail: String?) =
        jsEval("window.glassesOnStream&&window.glassesOnStream(${jsQ(state)},${detail?.let(::jsQ) ?: "null"})")

    private fun jsEval(code: String) {
        if (closed) return
        main.post { if (!closed) evaluate?.invoke(code) }
    }

    private fun jsQ(value: String): String = JSONObject.quote(value)
}
