package com.code2hack.glasses

import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.os.SystemClock

/**
 * G0 raw input tracer: records bounded, monotonic, timestamped traces for the
 * native Rokid interactions (function button, key/touch, motion). Every trace is
 * emitted under the project tag DSHGlasses and forwarded to the JS layer via
 * [onEvent] for on-screen evidence.
 *
 * Fields captured per assignment: action, key code, scan code, repeat count,
 * flags, source, device id/name, pointer count, coordinates, pressure/tool
 * type, monotonic timestamps, plus a `nativeVisible` flag when the device also
 * reacted natively (drives empiric "operator visible" classification).
 */
object InputTracer {
    private const val TAG = "DSHGlasses"
    var onEvent: ((String) -> Unit)? = null

    fun key(kind: String, event: KeyEvent, nativeVisible: Boolean): Boolean {
        emit(buildString {
            append(kind); append(' ')
            append("action=").append(actionName(event.action))
            append(" keyCode=").append(KeyEvent.keyCodeToString(event.keyCode))
            append(" scanCode=").append(event.scanCode)
            append(" repeat=").append(event.repeatCount)
            append(" flags=0x").append(event.flags.toString(16))
            append(" source=").append(event.source.toString(16))
            append(" device=").append(event.device?.id).append(':').append(event.device?.name)
            append(" eventUptime=").append(event.eventTime)
            append(" uptime=").append(SystemClock.uptimeMillis())
            append(" nativeVisible=").append(nativeVisible)
        })
        return false
    }

    fun motion(kind: String, event: MotionEvent, nativeVisible: Boolean): Boolean {
        val history = event.historySize
        emit(buildString {
            append(kind); append(' ')
            append("action=").append(event.actionMasked)
            append(" pointerCount=").append(event.pointerCount)
            append(" x=").append(event.x).append(" y=").append(event.y)
            append(" pressure=").append(event.pressure)
            append(" toolType=").append(event.getToolType(0))
            append(" source=").append(event.source.toString(16))
            append(" device=").append(event.device?.id).append(':').append(event.device?.name)
            append(" history=").append(history)
            append(" eventUptime=").append(event.eventTime)
            append(" uptime=").append(SystemClock.uptimeMillis())
            append(" nativeVisible=").append(nativeVisible)
        })
        return false
    }

    private fun actionName(a: Int) = when (a) {
        KeyEvent.ACTION_DOWN -> "DOWN"
        KeyEvent.ACTION_UP -> "UP"
        KeyEvent.ACTION_MULTIPLE -> "MULTIPLE"
        else -> a.toString()
    }

    private fun emit(line: String) {
        Log.i(TAG, line)
        onEvent?.invoke(line)
    }
}
