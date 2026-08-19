package com.code2hack.glasses

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log

/**
 * Debug-only dynamic sensor tracer for TB0-I0.
 *
 * It proves that the target Rokid can deliver Game Rotation Vector and
 * gyroscope samples to this APK. It deliberately performs no scrolling, tab
 * switching, thresholding, anchoring, or semantic control action.
 */
class SensorTracer(context: Context) : SensorEventListener {
    companion object {
        private const val TAG = "DSHGlassesSensor"
        private const val SAMPLE_PERIOD_US = 50_000 // request 20 Hz
        private const val MIN_LOG_PERIOD_NS = 50_000_000L // cap logs at 20 Hz
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
        gameRotation?.let { sensor ->
            val registered = manager.registerListener(this, sensor, SAMPLE_PERIOD_US, 0)
            Log.i(TAG, "register type=${sensor.type} name=${sensor.name} ok=$registered")
        }
        gyroscope?.let { sensor ->
            val registered = manager.registerListener(this, sensor, SAMPLE_PERIOD_US, 0)
            Log.i(TAG, "register type=${sensor.type} name=${sensor.name} ok=$registered")
        }
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
        val nowNs = SystemClock.elapsedRealtimeNanos()
        val previous = lastLoggedNs[event.sensor.type] ?: Long.MIN_VALUE
        if (previous != Long.MIN_VALUE && nowNs - previous < MIN_LOG_PERIOD_NS) return
        lastLoggedNs[event.sensor.type] = nowNs

        val values = event.values.joinToString(prefix = "[", postfix = "]", separator = ",") { value ->
            "%.6f".format(java.util.Locale.US, value)
        }
        Log.i(
            TAG,
            "sample type=${event.sensor.type}" +
                " name=${event.sensor.name}" +
                " vendor=${event.sensor.vendor}" +
                " sensorTimestampNs=${event.timestamp}" +
                " observedElapsedNs=$nowNs" +
                " accuracy=${event.accuracy}" +
                " values=$values",
        )
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        Log.i(
            TAG,
            "accuracy type=${sensor.type} name=${sensor.name} vendor=${sensor.vendor} accuracy=$accuracy",
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
