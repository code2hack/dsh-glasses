package com.code2hack.glasses

import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent

/**
 * G0 raw input tracer. It observes but never consumes an event. Native Rokid
 * side effects cannot be inferred from app delivery, so traces record them as
 * `unknown`; evidence correlates them separately with system logs/UI state.
 */
object InputTracer {
    private const val TAG = "DSHGlasses"

    var onEvent: ((String) -> Unit)? = null

    fun key(kind: String, event: KeyEvent, nativeEffect: String = "unknown") {
        emit(buildString {
            append(kind).append(' ')
            append("action=").append(keyActionName(event.action))
            append(" keyCode=").append(KeyEvent.keyCodeToString(event.keyCode))
            append(" keyCodeInt=").append(event.keyCode)
            append(" scanCode=").append(event.scanCode)
            append(" repeat=").append(event.repeatCount)
            append(" meta=0x").append(event.metaState.toString(16))
            append(" flags=0x").append(event.flags.toString(16))
            append(" source=0x").append(event.source.toString(16))
            append(" deviceId=").append(event.deviceId)
            append(" deviceName=").append(event.device?.name ?: "null")
            append(" downUptime=").append(event.downTime)
            append(" eventUptime=").append(event.eventTime)
            append(" observedUptime=").append(SystemClock.uptimeMillis())
            append(" nativeEffect=").append(nativeEffect)
        })
    }

    fun motion(kind: String, event: MotionEvent, nativeEffect: String = "unknown") {
        emit(buildString {
            append(kind).append(' ')
            append("action=").append(MotionEvent.actionToString(event.action))
            append(" actionMasked=").append(event.actionMasked)
            append(" actionIndex=").append(event.actionIndex)
            append(" pointerCount=").append(event.pointerCount)
            for (index in 0 until event.pointerCount) {
                append(" p").append(index).append("Id=").append(event.getPointerId(index))
                append(" p").append(index).append("X=").append(event.getX(index))
                append(" p").append(index).append("Y=").append(event.getY(index))
                append(" p").append(index).append("Pressure=").append(event.getPressure(index))
                append(" p").append(index).append("Tool=").append(event.getToolType(index))
            }
            append(" source=0x").append(event.source.toString(16))
            append(" deviceId=").append(event.deviceId)
            append(" deviceName=").append(event.device?.name ?: "null")
            append(" history=").append(event.historySize)
            append(" downUptime=").append(event.downTime)
            append(" eventUptime=").append(event.eventTime)
            append(" observedUptime=").append(SystemClock.uptimeMillis())
            append(" nativeEffect=").append(nativeEffect)
        })
    }

    fun lifecycle(event: String, details: String = "") {
        emit("LIFECYCLE event=$event uptime=${SystemClock.uptimeMillis()}${if (details.isEmpty()) "" else " $details"}")
    }

    private fun keyActionName(action: Int): String = when (action) {
        KeyEvent.ACTION_DOWN -> "DOWN"
        KeyEvent.ACTION_UP -> "UP"
        KeyEvent.ACTION_MULTIPLE -> "MULTIPLE"
        else -> action.toString()
    }

    private fun emit(line: String) {
        Log.i(TAG, line)
        onEvent?.invoke(line)
    }
}
