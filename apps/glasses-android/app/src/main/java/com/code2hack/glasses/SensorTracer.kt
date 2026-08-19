package com.code2hack.glasses

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log
import java.util.Locale

/**
 * Debug-only dynamic sensor tracer for TB0-I0.
 *
 * It proves that the target Rokid delivers Game Rotation Vector and gyroscope
 * samples to this APK. It deliberately performs no scrolling, tab switching,
 * thresholding, anchoring, or semantic control action.
 */
class SensorTracer(context: Context) : SensorEventListener {
    companion object {
        private const val TAG = "DSHGlassesSensor"
        private const val SAMPLE_PERIOD_US = 50_000 // request approximately 20 Hz
        private const val MIN_LOG_PERIOD_NS = 50_000_000L // cap each sensor at 20 Hz
    }

    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val gameRotation = manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    private val gyroscope = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val lastLoggedNs = mutableMapOf<Int, Long>()
    private var started = false

    fun start() {
        if (!BuildConfig.DEBUG || started) return
        started = true
        logInventory(gameRotation, "game-rotation-vector")
        logInventory(gyroscope, "gyroscope")
        register(gameRotation)
        register(gyroscope)
    }

    fun stop() {
        if (!started) return
        manager.unregisterListener(this)
        started = false
        lastLoggedNs.clear()
        Log.i(TAG, "unregistered")
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!started) return
        val observedNs = SystemClock.elapsedRealtimeNanos()
        val previousNs = lastLoggedNs[event.sensor.type]
        if (previousNs != null && observedNs - previousNs < MIN_LOG_PERIOD_NS) return
        lastLoggedNs[event.sensor.type] = observedNs

        val values = event.values.joinToString(
            prefix = "[",
            postfix = "]",
            separator = ",",
        ) { value -> String.format(Locale.US, "%.6f", value) }

        Log.i(
            TAG,
            "sample type=${event.sensor.type}" +
                " name=${event.sensor.name}" +
                " vendor=${event.sensor.vendor}" +
                " sensorTimestampNs=${event.timestamp}" +
                " observedElapsedNs=$observedNs" +
                " accuracy=${event.accuracy}" +
                " values=$values",
        )
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        Log.i(
            TAG,
            "accuracy type=${sensor.type}" +
                " name=${sensor.name}" +
                " vendor=${sensor.vendor}" +
                " accuracy=$accuracy",
        )
    }

    private fun register(sensor: Sensor?) {
        if (sensor == null) return
        val registered = manager.registerListener(this, sensor, SAMPLE_PERIOD_US, 0)
        Log.i(
            TAG,
            "register type=${sensor.type}" +
                " name=${sensor.name}" +
                " vendor=${sensor.vendor}" +
                " ok=$registered",
        )
    }

    private fun logInventory(sensor: Sensor?, role: String) {
        if (sensor == null) {
            Log.w(TAG, "inventory role=$role available=false")
            return
        }
        Log.i(
            TAG,
            "inventory role=$role available=true" +
                " type=${sensor.type}" +
                " name=${sensor.name}" +
                " vendor=${sensor.vendor}" +
                " version=${sensor.version}" +
                " wakeUp=${sensor.isWakeUpSensor}" +
                " reportingMode=${sensor.reportingMode}" +
                " minDelayUs=${sensor.minDelay}" +
                " maxDelayUs=${sensor.maxDelay}",
        )
    }
}
