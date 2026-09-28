package com.cove.instrumentation;

import org.objectweb.asm.*;

/** Narrow, build-time ABI checked integration; never patches node_modules. */
public final class ScreenSharingVisitor extends ClassVisitor {
    public static final String RUNTIME = "com/oney/WebRTCModule/CoveScreenRuntime";
    public static final String MODULE = "com/oney/WebRTCModule/WebRTCModule";
    public static final String OBSERVER = "com/oney/WebRTCModule/PeerConnectionObserver";
    public static final String CAPTURER = "org/webrtc/ScreenCapturerAndroid";
    public static final String RECORD = "org/webrtc/audio/WebRtcAudioRecord";
    private final String target;
    private int hooks;
    private boolean duplicate;
    public ScreenSharingVisitor(ClassVisitor next, String target) {
        super(Opcodes.ASM9, next); this.target = target;
    }
    @Override public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] errors) {
        MethodVisitor next = super.visitMethod(access, name, desc, sig, errors);
        return new MethodVisitor(Opcodes.ASM9, next) {
            @Override public void visitInsn(int opcode) {
                if (target.equals(CAPTURER) && name.equals("startCapture") && desc.equals("(III)V") && opcode == Opcodes.RETURN) {
                    super.visitVarInsn(Opcodes.ALOAD, 0);
                    super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, CAPTURER, "getMediaProjection", "()Landroid/media/projection/MediaProjection;", false);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "projectionStarted", "(Landroid/media/projection/MediaProjection;)V", false);
                    hooks++;
                }
                if (target.equals(MODULE) && name.equals("getLocalTrack") && desc.equals("(Ljava/lang/String;)Lorg/webrtc/MediaStreamTrack;") && opcode == Opcodes.ARETURN) {
                    super.visitVarInsn(Opcodes.ALOAD, 1);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "localTrack", "(Lorg/webrtc/MediaStreamTrack;Ljava/lang/String;)Lorg/webrtc/MediaStreamTrack;", false);
                    hooks++;
                }
                if (target.equals(MODULE) && name.equals("parseRTCConfiguration") && opcode == Opcodes.ARETURN) {
                    super.visitInsn(Opcodes.DUP);
                    super.visitVarInsn(Opcodes.ALOAD, 1);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "markConfiguration", "(Lorg/webrtc/PeerConnection$RTCConfiguration;Lcom/facebook/react/bridge/ReadableMap;)V", false);
                    hooks++;
                }
                super.visitInsn(opcode);
            }
            @Override public void visitMethodInsn(int opcode, String owner, String method, String descriptor, boolean iface) {
                if (owner.equals(RUNTIME)) duplicate = true;
                if (target.equals(OBSERVER) && name.equals("dispose") && owner.equals("org/webrtc/PeerConnection") && method.equals("dispose") && descriptor.equals("()V")) {
                    super.visitInsn(Opcodes.DUP);
                    super.visitMethodInsn(opcode, owner, method, descriptor, iface);
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "peerConnectionDisposed", "(Lorg/webrtc/PeerConnection;)V", false);
                    hooks++; return;
                }
                if (target.equals(MODULE) && name.startsWith("lambda$peerConnectionInit$") && owner.equals("org/webrtc/PeerConnectionFactory") && method.equals("createPeerConnection")) {
                    if (!descriptor.equals("(Lorg/webrtc/PeerConnection$RTCConfiguration;Lorg/webrtc/PeerConnection$Observer;)Lorg/webrtc/PeerConnection;")) throw new IllegalStateException("Screen PC factory ABI changed");
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "createPeerConnection", "(Lorg/webrtc/PeerConnectionFactory;Lorg/webrtc/PeerConnection$RTCConfiguration;Lorg/webrtc/PeerConnection$Observer;)Lorg/webrtc/PeerConnection;", false);
                    hooks++; return;
                }
                if (target.equals(RECORD) && name.equals("initRecording") && owner.equals(RECORD) && method.equals("createAudioRecordOnMOrHigher")) {
                    if (!descriptor.equals("(IIIII)Landroid/media/AudioRecord;")) throw new IllegalStateException("Playback AudioRecord ABI changed");
                    // Replace the constructor, rather than briefly opening a second microphone.
                    super.visitVarInsn(Opcodes.ALOAD, 0);
                    super.visitFieldInsn(Opcodes.GETFIELD, RECORD, "context", "Landroid/content/Context;");
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "createAudioRecord", "(IIIIILandroid/content/Context;)Landroid/media/AudioRecord;", false);
                    hooks++; return;
                }
                super.visitMethodInsn(opcode, owner, method, descriptor, iface);
            }
        };
    }
    @Override public void visitEnd() {
        int expected = target.equals(MODULE) ? 4 : 1; // two configuration returns, track lookup, PC creation
        if (duplicate || hooks != expected) throw new IllegalStateException("Screen sharing ABI integration requires review: " + target + " hooks=" + hooks);
        super.visitEnd();
    }
}
