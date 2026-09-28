package com.cove.instrumentation;

import org.junit.Test;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import java.io.*;
import java.util.jar.*;
import java.util.zip.ZipFile;
import static org.junit.Assert.*;

public class ScreenSharingVisitorTest {
    private byte[] actual(String target) throws IOException {
        if (target.equals(ScreenSharingVisitor.MODULE) || target.equals(ScreenSharingVisitor.OBSERVER)) {
            try (ZipFile jar = new ZipFile(System.getProperty("cove.rnwebrtc.jar"))) {
                return jar.getInputStream(jar.getEntry(target + ".class")).readAllBytes();
            }
        }
        try (ZipFile aar = new ZipFile(System.getProperty("cove.webrtc.aar"));
             JarInputStream jar = new JarInputStream(aar.getInputStream(aar.getEntry("libs/libwebrtc.jar")))) {
            JarEntry entry;
            while ((entry = jar.getNextJarEntry()) != null) if (entry.getName().equals(target + ".class")) return jar.readAllBytes();
        }
        throw new AssertionError("Required WebRTC class absent: " + target);
    }
    private byte[] transform(String target, byte[] original) {
        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        new ClassReader(original).accept(new ScreenSharingVisitor(writer, target), 0);
        return writer.toByteArray();
    }
    @Test public void actualDependenciesHaveExactlyTheRequiredHooks() throws Exception {
        for (String target : new String[]{ScreenSharingVisitor.MODULE, ScreenSharingVisitor.OBSERVER, ScreenSharingVisitor.RECORD, ScreenSharingVisitor.CAPTURER}) {
            byte[] patched = transform(target, actual(target));
            ClassNode node = new ClassNode(); new ClassReader(patched).accept(node, 0);
            int hooks = 0;
            for (MethodNode method : node.methods) for (AbstractInsnNode insn : method.instructions) {
                if (insn instanceof MethodInsnNode && ((MethodInsnNode) insn).owner.equals(ScreenSharingVisitor.RUNTIME)) hooks++;
            }
            assertEquals(target, target.equals(ScreenSharingVisitor.MODULE) ? 4 : 1, hooks);
            assertThrows(IllegalStateException.class, () -> transform(target, patched));
        }
    }
    @Test public void futureABIBreaksFailTheBuildInsteadOfSilentlySendingMicAsScreenAudio() {
        ClassWriter writer = new ClassWriter(0);
        writer.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, ScreenSharingVisitor.RECORD, null, "java/lang/Object", null);
        writer.visitEnd();
        assertThrows(IllegalStateException.class, () -> transform(ScreenSharingVisitor.RECORD, writer.toByteArray()));
    }
}
