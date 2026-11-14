package com.kisushotto.trades.app;

import android.graphics.Color;
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

// App del Trade Journal: un WebView que carga trades.kisushotto.com/terminal
// (server.url en capacitor.config.json). Los cambios de la web no piden APK nuevo.
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));

        // La web no se dibuja debajo de las barras del sistema ni del teclado
        final WebView web = bridge.getWebView();
        View root = (View) web.getParent();
        root.setBackgroundColor(0xFF181818);
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

        // Atras: vuelve a la pagina anterior; sin historial manda la app al fondo
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });
    }
}
