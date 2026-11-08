package com.kisushotto.health.app;

import android.Manifest;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.view.HapticFeedbackConstants;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.Locale;

// window.Capacitor.Plugins.Native en la web (nativeApp() en health/).
@CapacitorPlugin(name = "Native", permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }))
public class NativePlugin extends Plugin {

    // ── Voz: el WebView de Android no trae speechSynthesis ──────────────────
    private TextToSpeech tts;
    private boolean ttsReady = false;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS) return;
            Locale es = Locale.forLanguageTag("es-US");
            if (tts.isLanguageAvailable(es) < TextToSpeech.LANG_AVAILABLE) es = new Locale("es");
            tts.setLanguage(es);
            tts.setSpeechRate(1.05f);
            ttsReady = true;
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }

    @PluginMethod
    public void say(PluginCall call) {
        String text = call.getString("text", "");
        if (ttsReady && !text.isEmpty()) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "health");
        JSObject r = new JSObject();
        r.put("ok", ttsReady);
        call.resolve(r);
    }

    // ── Pantalla encendida mientras corre el temporizador (sin Wake Lock en el WebView) ──
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // Hora de fin de la cuenta en curso (0 = ninguna). Ver TimerAlarm.
    @PluginMethod
    public void timer(PluginCall call) {
        Double at = call.getDouble("at", 0d);
        TimerAlarm.at = at == null ? 0 : at.longValue();
        TimerAlarm.title = call.getString("title", "Health");
        TimerAlarm.body = call.getString("body", "");
        // El aviso necesita el permiso de notificaciones (Android 13+): se pide la primera vez
        if (TimerAlarm.at > 0 && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "timerPermCb");
            return;
        }
        call.resolve();
    }

    @PermissionCallback
    private void timerPermCb(PluginCall call) {
        call.resolve();
    }

    // La vibracion del teclado del sistema (anda con el telefono en silencio).
    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "key");
        int efecto;
        if ("err".equals(kind)) efecto = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
        else if ("tick".equals(kind)) efecto = HapticFeedbackConstants.CLOCK_TICK;
        else efecto = HapticFeedbackConstants.KEYBOARD_TAP;
        getActivity().runOnUiThread(() -> getBridge().getWebView().performHapticFeedback(efecto));
        call.resolve();
    }

    // ── Recordatorios por FCM ────────────────────────────────────────────────
    // Token para el recordatorio diario. En Android 13+ pide antes el permiso de
    // notificaciones (el dialogo del sistema, una sola vez).
    @PluginMethod
    public void pushToken(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "pushPermCb");
            return;
        }
        token(call);
    }

    @PermissionCallback
    private void pushPermCb(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("denied");
            return;
        }
        token(call);
    }

    private void token(PluginCall call) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
                if (!t.isSuccessful()) {
                    call.reject("token: " + (t.getException() != null ? t.getException().getMessage() : "?"));
                    return;
                }
                JSObject r = new JSObject();
                r.put("token", t.getResult());
                call.resolve(r);
            });
        } catch (IllegalStateException e) {
            // APK compilado sin google-services.json: Firebase no esta inicializado.
            call.reject("not set up");
        }
    }

    // Pestana que pidio la notificacion tocada con la app cerrada (la web la lee al arrancar).
    @PluginMethod
    public void pushOpen(PluginCall call) {
        JSObject r = new JSObject();
        r.put("url", MainActivity.pendingUrl);
        MainActivity.pendingUrl = null;
        call.resolve(r);
    }
}
