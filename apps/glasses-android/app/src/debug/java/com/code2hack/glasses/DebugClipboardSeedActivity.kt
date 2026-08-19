package com.code2hack.glasses

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.util.Base64
import android.util.Log
import java.nio.charset.StandardCharsets

/**
 * Debug-only ADB clipboard fixture used by TB0-D1.
 *
 * The Activity exists only in the debug source set. It accepts UTF-8 text as a
 * Base64 intent extra so ADB shell quoting never changes the payload, logs only
 * the character count, writes the system clipboard, and immediately exits.
 */
class DebugClipboardSeedActivity : Activity() {
    companion object {
        private const val TAG = "DSHGlassesDebug"
        private const val EXTRA_TEXT_B64 = "text_b64"
        private const val MAX_CHARS = 16_384
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BuildConfig.DEBUG) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val encoded = intent.getStringExtra(EXTRA_TEXT_B64)
        if (encoded.isNullOrEmpty()) {
            Log.w(TAG, "clipboard-seed refused missing payload")
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val text = try {
            String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8)
        } catch (error: IllegalArgumentException) {
            Log.w(TAG, "clipboard-seed refused invalid base64")
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        if (text.length > MAX_CHARS) {
            Log.w(TAG, "clipboard-seed refused chars=${text.length} max=$MAX_CHARS")
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("dsh-debug", text))
        Log.i(TAG, "clipboard-seeded chars=${text.length}")
        setResult(RESULT_OK)
        finish()
    }
}
