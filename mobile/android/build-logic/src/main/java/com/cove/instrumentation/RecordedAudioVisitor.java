package com.cove.instrumentation;

import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/** Version-checked hook on Jitsi WebRTC 124's existing capture thread.
 * Processes the SAME direct buffer before nativeDataIsRecorded, not the copied
 * SamplesReadyCallback data (delivered after the native send). Never replaces
 * or stops AudioRecord, its thread, mute logic or timestamps. */
public final class RecordedAudioVisitor extends ClassVisitor {
    public static final String RECORD = "org/webrtc/audio/WebRtcAudioRecord";
    public static final String THREAD = RECORD + "$AudioRecordThread";
    public static final String RUNTIME = "com/covemobile/audio/MicrophoneNoiseRuntime";
    public static final String HOOK_DESCRIPTOR = "(Landroid/media/AudioRecord;Ljava/nio/ByteBuffer;IIIZ)V";
    private int sends;
    private boolean alreadyHooked;

    public RecordedAudioVisitor(ClassVisitor next) { super(Opcodes.ASM9, next); }
    @Override public MethodVisitor visitMethod(int access, String name, String descriptor,
                                               String signature, String[] exceptions) {
        MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
        if (!name.equals("run") || !descriptor.equals("()V")) return next;
        return new MethodVisitor(Opcodes.ASM9, next) {
            private void recordField(String field, String type) {
                super.visitVarInsn(Opcodes.ALOAD, 0);
                super.visitFieldInsn(Opcodes.GETFIELD, THREAD, "this$0", "L" + RECORD + ";");
                super.visitFieldInsn(Opcodes.GETFIELD, RECORD, field, type);
            }
            @Override public void visitMethodInsn(int opcode, String owner, String method,
                                                   String desc, boolean isInterface) {
                if (owner.equals(RUNTIME) && method.equals("processRecordedBuffer")) alreadyHooked = true;
                if (owner.equals(RECORD) && method.equals("nativeDataIsRecorded")) {
                    if (opcode != Opcodes.INVOKEVIRTUAL || !desc.equals("(JIJ)V")) {
                        throw new IllegalStateException("WebRTC audio send ABI changed; review the RNNoise hook");
                    }
                    sends++;
                    // Keep the original receiver/pointer/length/timestamp stack intact.
                    recordField("audioRecord", "Landroid/media/AudioRecord;");
                    recordField("byteBuffer", "Ljava/nio/ByteBuffer;");
                    for (String getter : new String[]{"getSampleRate", "getChannelCount", "getAudioFormat"}) {
                        recordField("audioRecord", "Landroid/media/AudioRecord;");
                        super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "android/media/AudioRecord", getter, "()I", false);
                    }
                    recordField("microphoneMute", "Z");
                    super.visitMethodInsn(Opcodes.INVOKESTATIC, RUNTIME, "processRecordedBuffer", HOOK_DESCRIPTOR, false);
                }
                super.visitMethodInsn(opcode, owner, method, desc, isInterface);
            }
        };
    }
    @Override public void visitEnd() {
        if (sends != 1 || alreadyHooked) {
            throw new IllegalStateException("Expected exactly one unmodified WebRTC capture send; found " + sends
                + ". Review the RNNoise hook before updating WebRTC.");
        }
        super.visitEnd();
    }
}
