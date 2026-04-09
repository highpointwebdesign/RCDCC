package com.rcdcc.app;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Phones stay portrait; tablets are allowed to rotate.
        if (isTabletDevice()) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }

        // Modern edge-to-edge (replaces FLAG_LAYOUT_NO_LIMITS)
        EdgeToEdge.enable(this);

        // Hide nav bar, show on swipe
        WindowInsetsControllerCompat insetsController =
            new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        insetsController.hide(WindowInsetsCompat.Type.navigationBars());
        insetsController.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
    }

    private boolean isTabletDevice() {
        Configuration config = getResources().getConfiguration();
        return config.smallestScreenWidthDp >= 600;
    }
}