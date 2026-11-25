package com.cove.instrumentation;

import java.util.zip.ZipFile;
import org.junit.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TypeInsnNode;
import static org.junit.Assert.*;

public class ScreenRotationVisitorTest {
    private byte[] transform(byte[] original) {
        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        new ClassReader(original).accept(new ScreenRotationVisitor(writer), 0);
        return writer.toByteArray();
    }

    @Test public void libraryScreenTrackUsesTheDisplayAwareController() throws Exception {
        byte[] patched;
        try (ZipFile jar = new ZipFile(System.getProperty("cove.rnwebrtc.jar"))) {
            patched = transform(jar.getInputStream(
                jar.getEntry(ScreenSharingVisitor.GET_USER_MEDIA + ".class")).readAllBytes());
        }
        ClassNode node = new ClassNode();
        new ClassReader(patched).accept(node, 0);
        int allocations = 0, constructors = 0;
        for (MethodNode method : node.methods) {
            for (AbstractInsnNode instruction : method.instructions) {
                if (instruction instanceof TypeInsnNode && instruction.getOpcode() == Opcodes.NEW) {
                    String type = ((TypeInsnNode) instruction).desc;
                    assertNotEquals(ScreenRotationVisitor.BASE, type);
                    if (type.equals(ScreenRotationVisitor.CONTROLLER)) {
                        assertEquals("createScreenTrack", method.name);
                        allocations++;
                    }
                }
                if (instruction instanceof MethodInsnNode) {
                    MethodInsnNode call = (MethodInsnNode) instruction;
                    if (call.owner.equals(ScreenRotationVisitor.CONTROLLER)) {
                        assertEquals("createScreenTrack", method.name);
                        assertEquals(Opcodes.INVOKESPECIAL, call.getOpcode());
                        assertEquals("<init>", call.name);
                        assertEquals(ScreenRotationVisitor.CONSTRUCTOR, call.desc);
                        constructors++;
                    }
                }
            }
        }
        assertEquals(1, allocations);
        assertEquals(1, constructors);
        assertThrows(IllegalStateException.class, () -> transform(patched));
    }
}
