package com.cove.instrumentation;

import org.junit.Test;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import java.io.*;
import java.util.jar.JarInputStream;
import java.util.zip.ZipFile;
import static org.junit.Assert.*;

public class RecordedAudioVisitorTest {
    private byte[] actualCaptureThread() throws IOException {
        try (ZipFile aar = new ZipFile(System.getProperty("cove.webrtc.aar"));
             JarInputStream jar = new JarInputStream(aar.getInputStream(aar.getEntry("libs/libwebrtc.jar")))) {
            java.util.jar.JarEntry entry;
            while ((entry = jar.getNextJarEntry()) != null) {
                if (entry.getName().equals(RecordedAudioVisitor.THREAD + ".class")) return jar.readAllBytes();
            }
        }
        throw new AssertionError("WebRTC capture thread absent: the pre-send integration must be reviewed");
    }
    private byte[] transform(byte[] original) {
        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        new ClassReader(original).accept(new RecordedAudioVisitor(writer), 0);
        return writer.toByteArray();
    }
    @Test public void actualDependencyIsProcessedBeforeExactlyOneNativeSend() throws Exception {
        ClassNode node = new ClassNode();
        new ClassReader(transform(actualCaptureThread())).accept(node, 0);
        int hooks = 0, sends = 0, stops = 0;
        for (MethodNode method : node.methods) {
            if (!method.name.equals("run")) continue;
            for (AbstractInsnNode insn : method.instructions) {
                if (!(insn instanceof MethodInsnNode)) continue;
                MethodInsnNode call = (MethodInsnNode) insn;
                if (call.owner.equals(RecordedAudioVisitor.RUNTIME)) {
                    hooks++;
                    assertEquals("processRecordedBuffer", call.name);
                    assertEquals(RecordedAudioVisitor.HOOK_DESCRIPTOR, call.desc);
                    assertEquals(RecordedAudioVisitor.RECORD, ((MethodInsnNode) call.getNext()).owner);
                    assertEquals("nativeDataIsRecorded", ((MethodInsnNode) call.getNext()).name);
                }
                if (call.name.equals("nativeDataIsRecorded")) {
                    sends++;
                    assertEquals("(JIJ)V", call.desc);
                }
                if (call.owner.equals("android/media/AudioRecord") && call.name.equals("stop")) stops++;
            }
        }
        assertEquals(1, hooks);
        assertEquals(1, sends);
        assertEquals(1, stops);
    }
    @Test public void duplicateTransformationFailsInsteadOfDenoisingTwice() throws Exception {
        byte[] transformed = transform(actualCaptureThread());
        assertThrows(IllegalStateException.class, () -> transform(transformed));
    }
    @Test public void missingSendFailsInsteadOfShippingANonfunctionalHook() {
        ClassWriter writer = new ClassWriter(0);
        writer.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, RecordedAudioVisitor.THREAD, null, "java/lang/Thread", null);
        writer.visitEnd();
        assertThrows(IllegalStateException.class, () -> transform(writer.toByteArray()));
    }
}
