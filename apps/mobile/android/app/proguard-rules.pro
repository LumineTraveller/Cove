# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# RNNoise 采集拦截通过反射读取 WebRTC JavaAudioDeviceModule / WebRtcAudioRecord
# 的私有字段与方法，混淆后字段名会变，必须保留。
-keep class org.webrtc.audio.JavaAudioDeviceModule { *; }
-keep class org.webrtc.audio.WebRtcAudioRecord { *; }
-keep class org.webrtc.audio.WebRtcAudioRecord$AudioRecordThread { *; }
-keep class com.covemobile.RnnoiseEngine { *; }
