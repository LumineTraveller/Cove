package com.oney.WebRTCModule;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.Size;
import java.util.concurrent.atomic.AtomicReference;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.VideoCapturer;

/** Resize the active recording after Android commits the display's new geometry. */
public final class CoveScreenCaptureController extends ScreenCaptureController {
    private static final String TAG = "CoveScreenCapture";
    private static final long DISPLAY_CHECK_MS = 500;
    private final Activity activity;
    private final float scale;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicReference<Size> requestedSize = new AtomicReference<>();
    private volatile boolean observing;
    private volatile boolean projectionReportsSize;
    private MediaProjection projection;
    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onCapturedContentResize(int width, int height) {
            if (!observing || width <= 0 || height <= 0) return;
            projectionReportsSize = true;
            mainHandler.removeCallbacks(checkDisplay);
            resizeCapture((int) (width * scale), (int) (height * scale));
        }
    };
    private final Runnable checkDisplay = new Runnable() {
        @Override public void run() {
            if (!observing || projectionReportsSize) return;
            resizeToDisplay();
            mainHandler.postDelayed(this, DISPLAY_CHECK_MS);
        }
    };

    public CoveScreenCaptureController(Context context, int width, int height,
            Intent permission, float scale) {
        super(context, width, height, permission, scale);
        activity = (Activity) context;
        this.scale = scale;
    }

    @Override public void startCapture() {
        super.startCapture();
        observeDisplay();
    }

    @Override public boolean stopCapture() {
        stopObserving();
        return super.stopCapture();
    }

    @Override public void dispose() {
        stopObserving();
        super.dispose();
    }

    private synchronized void observeDisplay() {
        if (observing) return;
        ScreenCapturerAndroid capturer = (ScreenCapturerAndroid) getVideoCapturer();
        if (capturer == null || capturer.getMediaProjection() == null) return;
        projection = capturer.getMediaProjection();
        requestedSize.set(new Size(getWidth(), getHeight()));
        projectionReportsSize = false;
        observing = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            projection.registerCallback(projectionCallback, mainHandler);
        }
        // Check the display until the projection begins reporting the captured area's size.
        mainHandler.post(checkDisplay);
        Log.d(TAG, "Watching display size for the active projection");
    }

    private synchronized void stopObserving() {
        if (!observing) return;
        observing = false;
        requestedSize.set(null);
        mainHandler.removeCallbacks(checkDisplay);
        projection.unregisterCallback(projectionCallback);
        projection = null;
    }

    private void resizeToDisplay() {
        if (!observing) return;
        DisplayMetrics metrics = DisplayUtils.getDisplayMetrics(activity);
        int width = (int) (metrics.widthPixels * scale);
        int height = (int) (metrics.heightPixels * scale);
        // Android can publish the new orientation before refreshing the cached display metrics.
        int orientation = activity.getResources().getConfiguration().orientation;
        boolean invertAxes = (orientation == Configuration.ORIENTATION_LANDSCAPE && width < height)
            || (orientation == Configuration.ORIENTATION_PORTRAIT && width > height);
        resizeCapture(invertAxes ? height : width, invertAxes ? width : height);
    }

    private void resizeCapture(int newWidth, int newHeight) {
        if (!observing || newWidth <= 0 || newHeight <= 0) return;
        Size previous = requestedSize.get();
        if (previous != null && previous.getWidth() == newWidth && previous.getHeight() == newHeight) return;
        Size requested = new Size(newWidth, newHeight);
        requestedSize.set(requested);
        // The same executor also owns track creation, disposal and WebRTC format updates.
        ThreadUtils.runOnExecutor(() -> {
            VideoCapturer capturer = getVideoCapturer();
            if (!observing || capturer == null || requestedSize.get() != requested) return;
            if (newWidth == getWidth() && newHeight == getHeight()) return;
            try {
                capturer.changeCaptureFormat(newWidth, newHeight, getFrameRate());
                targetWidth = actualWidth = newWidth;
                targetHeight = actualHeight = newHeight;
                Log.d(TAG, "Resized active capture to " + newWidth + "x" + newHeight);
            } catch (RuntimeException error) {
                requestedSize.compareAndSet(requested, null);
                Log.w(TAG, "Unable to resize the display capture", error);
            }
        });
    }
}
