package com.kisushotto.health.app;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

// App de Health: un WebView que carga health.kisushotto.com (server.url en
// capacitor.config.json). Lo nativo es solo lo que el WebView no trae: voz,
// pantalla encendida y recordatorios por FCM (NativePlugin / PushService).
public class MainActivity extends BridgeActivity {

    // Pestaña de una notificacion tocada ("/#rutina"). Con la app cerrada la web
    // todavia no cargo: la pide al arrancar (NativePlugin.pushOpen).
    static String pendingUrl = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePlugin.class);
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        PushService.ensureChannel(this);
        pendingUrl = pushUrl(getIntent());

        // La web no se dibuja debajo de las barras del sistema: se corre el WebView
        // (y el teclado lo achica). Detras de las barras: arriba el fondo de la web
        // y abajo el de la barra de pestanas, para que llegue hasta el borde.
        final WebView web = bridge.getWebView();
        View root = (View) web.getParent();
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{0xFF0E0F13, 0xFF0E0F13, 0xFF16171C, 0xFF16171C}));
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            int tipos = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets bars = insets.getInsets(tipos);
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(tipos, Insets.NONE)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });

        // Atras: vuelve a la pestana anterior (la web las apila en el history) y,
        // sin nada a donde volver, manda la app al fondo en vez de cerrarla.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    private static String pushUrl(Intent intent) {
        String u = intent == null ? null : intent.getStringExtra("url");
        return u != null && u.startsWith("/#") ? u : null;
    }

    // Notificacion tocada con la app abierta: solo cambia de pestana.
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String u = pushUrl(intent);
        if (u != null) bridge.getWebView().evaluateJavascript("location.hash=" + org.json.JSONObject.quote(u.substring(1)), null);
    }
}
