package com.kisushotto.health.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// Recordatorios por FCM (los manda el cron de habits-worker).
public class PushService extends FirebaseMessagingService {

    static final String CHANNEL = "reminders";

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Recordatorios", NotificationManager.IMPORTANCE_DEFAULT));
    }

    // Abre la app en una pestana ("/#hoy"). Un requestCode por URL para que no se pisen.
    static PendingIntent openIntent(Context c, String url) {
        Intent i = new Intent(c, MainActivity.class)
            .putExtra("url", url)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, url == null ? 0 : url.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // v1: llega con "notification" (Android la muestra solo con la app en segundo plano).
    // v2: solo "data" (title, body, kind, quick, actions): siempre pasa por aca, asi
    // el check-in de la noche lleva botones que responden sin abrir la app.
    @Override
    public void onMessageReceived(RemoteMessage m) {
        Map<String, String> d = m.getData();
        RemoteMessage.Notification n = m.getNotification();
        String title = n != null ? n.getTitle() : d.get("title");
        String body = n != null ? n.getBody() : d.get("body");
        if (title == null) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(this);
        String tag = d.get("tag") != null ? d.get("tag") : "daily";
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(0xFF4F86FF)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(openIntent(this, d.get("url")));
        String quick = d.get("quick");
        if (quick != null && quick.startsWith("https://")) {
            try {
                JSONArray acts = new JSONArray(d.get("actions") != null ? d.get("actions") : "[]");
                for (int k = 0; k < acts.length() && k < 3; k++) {
                    JSONObject a = acts.getJSONObject(k);
                    Intent i = new Intent(this, QuickReply.class)
                        .putExtra("quick", quick).putExtra("action", a.getString("action")).putExtra("tag", tag);
                    PendingIntent pi = PendingIntent.getBroadcast(this, k + 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    b.addAction(0, a.getString("title"), pi);
                }
            } catch (JSONException ignored) {}
        }
        NotificationManagerCompat.from(this).notify(tag, 0, b.build());
    }

    // Un token nuevo lo registra la web la proxima vez que se abre la app (pushToken).
    @Override
    public void onNewToken(String token) {}
}
