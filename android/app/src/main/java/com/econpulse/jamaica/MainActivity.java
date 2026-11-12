package com.econpulse.jamaica;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NanoPlugin.class); // on-device Gemini Nano (AICore)
        super.onCreate(savedInstanceState);
    }
}
