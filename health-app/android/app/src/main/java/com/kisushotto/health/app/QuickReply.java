package com.kisushotto.health.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.net.HttpURLConnection;
import java.net.URL;

// Boton de una notificacion ("¿Seguiste el plan?" Si / Mas o menos / No): guarda
// la respuesta en habits-worker sin abrir la app (enlace firmado, sin sesion).
public class QuickReply extends BroadcastReceiver {

    @Override
    public void onReceive(Context c, Intent i) {
        String quick = i.getStringExtra("quick"), action = i.getStringExtra("action"), tag = i.getStringExtra("tag");
        if (quick == null || action == null) return;
        final PendingResult pr = goAsync();
        new Thread(() -> {
            boolean ok = false;
            try {
                HttpURLConnection h = (HttpURLConnection) new URL(quick + "&v=" + action).openConnection();
                h.setRequestMethod("POST");
                h.setConnectTimeout(10000);
                h.setReadTimeout(10000);
                ok = h.getResponseCode() == 200;
                h.disconnect();
            } catch (Exception ignored) {}
            try {
                NotificationCompat.Builder b = new NotificationCompat.Builder(c, PushService.CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setColor(0xFF4F86FF)
                    .setContentTitle(ok ? "Guardado ✓" : "No se pudo guardar")
                    .setContentText(ok ? "Gracias, quedó en tu día." : "Ábrela y márcalo en Hoy.")
                    .setTimeoutAfter(ok ? 4000 : 0)
                    .setAutoCancel(true)
                    .setContentIntent(PushService.openIntent(c, "/#hoy"));
                NotificationManagerCompat.from(c).notify(tag != null ? tag : "health-checkin", 0, b.build());
            } catch (SecurityException ignored) {}
            pr.finish();
        }).start();
    }
}
