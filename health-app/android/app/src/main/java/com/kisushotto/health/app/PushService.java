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

// Recordatorios por FCM (los manda el cron de habits-worker). Con la app en
// segundo plano Android lo muestra solo en el canal "reminders"; aca llega cuando
// la app esta abierta, y entonces hay que mostrarlo a mano.
public class PushService extends FirebaseMessagingService {

    static final String CHANNEL = "reminders";

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Recordatorios", NotificationManager.IMPORTANCE_DEFAULT));
    }

    @Override
    public void onMessageReceived(RemoteMessage m) {
        RemoteMessage.Notification n = m.getNotification();
        if (n == null) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(this);
        Intent i = new Intent(this, MainActivity.class)
            .putExtra("url", m.getData().get("url"))
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(0xFF4F86FF)
            .setContentTitle(n.getTitle())
            .setContentText(n.getBody())
            .setStyle(new NotificationCompat.BigTextStyle().bigText(n.getBody()))
            .setAutoCancel(true)
            .setContentIntent(pi);
        String tag = m.getData().get("tag");
        NotificationManagerCompat.from(this).notify(tag != null ? tag : "daily", 0, b.build());
    }

    // Un token nuevo lo registra la web la proxima vez que se abre la app (pushToken).
    @Override
    public void onNewToken(String token) {}
}
