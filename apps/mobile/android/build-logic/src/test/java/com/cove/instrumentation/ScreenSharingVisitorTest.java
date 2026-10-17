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
        if (target.equals(ScreenSharingVisitor.MODULE) || target.equals(ScreenSharingVisitor.OBSERVER)
            || target.equals(ScreenSharingVisitor.GET_USER_MEDIA)) {
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
        for (String target : new String[]{ScreenSharingVisitor.MODULE, ScreenSharingVisitor.OBSERVER, ScreenSharingVisitor.RECORD, ScreenSharingVisitor.CAPTURER, ScreenSharingVisitor.GET_USER_MEDIA}) {
            byte[] patched = transform(target, actual(target));
            ClassNode node = new ClassNode(); new ClassReader(patched).accept(node, 0);
            int hooks = 0;
            for (MethodNode method : node.methods) for (AbstractInsnNode insn : method.instructions) {
                if (insn instanceof MethodInsnNode) {
                    String owner = ((MethodInsnNode) insn).owner;
                    if (owner.equals(ScreenSharingVisitor.RUNTIME) || owner.equals(ScreenSharingVisitor.VIDEO_SOURCE_RUNTIME)) hooks++;
                }
            }
            assertEquals(target, target.equals(ScreenSharingVisitor.MODULE) ? 4 : 1, hooks);
            assertThrows(IllegalStateException.class, () -> transform(target, patched));
        }
    }
    @Test public void actualVideoSourceHookRunsBeforeCapturerInitialization() throws Exception {
        ClassNode node = new ClassNode();
        new ClassReader(transform(ScreenSharingVisitor.GET_USER_MEDIA, actual(ScreenSharingVisitor.GET_USER_MEDIA))).accept(node, 0);
        int hooks = 0, originalCreates = 0, initializes = 0, helpers = 0;
        for (MethodNode method : node.methods) {
            if (!method.name.equals("createVideoTrack") || !method.desc.equals(ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR)) continue;
            for (AbstractInsnNode insn : method.instructions) {
                if (!(insn instanceof MethodInsnNode)) continue;
                MethodInsnNode call = (MethodInsnNode) insn;
                if (call.owner.equals(ScreenSharingVisitor.VIDEO_SOURCE_RUNTIME)) {
                    assertEquals(0, initializes);
                    assertEquals(Opcodes.INVOKESTATIC, call.getOpcode());
                    assertEquals("createVideoSource", call.name);
                    assertEquals(ScreenSharingVisitor.CREATE_VIDEO_SOURCE_DESCRIPTOR, call.desc);
                    assertFalse(call.itf);
                    hooks++;
                }
                if (call.owner.equals("org/webrtc/PeerConnectionFactory") && call.name.equals("createVideoSource")) originalCreates++;
                if (call.owner.equals("org/webrtc/VideoCapturer") && call.name.equals("initialize")) {
                    assertEquals(1, hooks);
                    assertEquals("(Lorg/webrtc/SurfaceTextureHelper;Landroid/content/Context;Lorg/webrtc/CapturerObserver;)V", call.desc);
                    initializes++;
                }
                if (call.owner.equals("org/webrtc/SurfaceTextureHelper") && call.name.equals("create")) helpers++;
            }
        }
        assertEquals(1, hooks);
        assertEquals(0, originalCreates);
        assertEquals(1, initializes);
        assertEquals(1, helpers);
    }
    @Test public void actualWebRtcProvidesFpsOnlyAdaptationAbi() throws Exception {
        ClassNode source = new ClassNode();
        new ClassReader(actual("org/webrtc/VideoSource")).accept(source, 0);
        assertTrue(source.methods.stream().anyMatch(method -> method.name.equals("adaptOutputFormat")
            && method.desc.equals("(Lorg/webrtc/VideoSource$AspectRatio;Ljava/lang/Integer;Lorg/webrtc/VideoSource$AspectRatio;Ljava/lang/Integer;Ljava/lang/Integer;)V")
            && (method.access & Opcodes.ACC_PUBLIC) != 0));
        ClassNode ratio = new ClassNode();
        new ClassReader(actual("org/webrtc/VideoSource$AspectRatio")).accept(ratio, 0);
        assertTrue(ratio.fields.stream().anyMatch(field -> field.name.equals("UNDEFINED")
            && field.desc.equals("Lorg/webrtc/VideoSource$AspectRatio;")
            && (field.access & (Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC | Opcodes.ACC_FINAL))
                == (Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC | Opcodes.ACC_FINAL)));
    }
    @Test public void sourceFactoryAbiChangesAndMissingOrRepeatedCallsFailClosed() {
        String sourceDescriptor = "(Z)Lorg/webrtc/VideoSource;";
        for (byte[] fixture : new byte[][] {
            sourceFactoryFixture("createVideoTrack", ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR, "(ZZ)Lorg/webrtc/VideoSource;", 1),
            sourceFactoryFixture("createVideoTrack", "(Ljava/lang/Object;)Lorg/webrtc/VideoTrack;", sourceDescriptor, 1),
            sourceFactoryFixture("createVideoTrack", ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR, sourceDescriptor, 0),
            sourceFactoryFixture("createVideoTrack", ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR, sourceDescriptor, 2),
            sourceFactoryFixture("otherMethod", ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR, sourceDescriptor, 1)
        }) {
            assertThrows(IllegalStateException.class, () -> transform(ScreenSharingVisitor.GET_USER_MEDIA, fixture));
        }
    }
    @Test public void matchingFactoryCallsOutsideCreateVideoTrackAreUntouched() {
        ClassWriter writer = sourceFactoryClass();
        addSourceFactoryMethod(writer, "createVideoTrack", ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR, "(Z)Lorg/webrtc/VideoSource;", 1);
        addSourceFactoryMethod(writer, "otherMethod", ScreenSharingVisitor.CREATE_VIDEO_TRACK_DESCRIPTOR, "(Z)Lorg/webrtc/VideoSource;", 1);
        writer.visitEnd();
        ClassNode node = new ClassNode();
        new ClassReader(transform(ScreenSharingVisitor.GET_USER_MEDIA, writer.toByteArray())).accept(node, 0);
        int untouched = 0;
        for (MethodNode method : node.methods) {
            if (!method.name.equals("otherMethod")) continue;
            for (AbstractInsnNode insn : method.instructions) if (insn instanceof MethodInsnNode) {
                MethodInsnNode call = (MethodInsnNode) insn;
                assertEquals("org/webrtc/PeerConnectionFactory", call.owner);
                assertEquals("createVideoSource", call.name);
                assertEquals(Opcodes.INVOKEVIRTUAL, call.getOpcode());
                untouched++;
            }
        }
        assertEquals(1, untouched);
    }
    private ClassWriter sourceFactoryClass() {
        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        writer.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, ScreenSharingVisitor.GET_USER_MEDIA, null, "java/lang/Object", null);
        return writer;
    }
    private byte[] sourceFactoryFixture(String name, String descriptor, String sourceDescriptor, int calls) {
        ClassWriter writer = sourceFactoryClass();
        addSourceFactoryMethod(writer, name, descriptor, sourceDescriptor, calls);
        writer.visitEnd();
        return writer.toByteArray();
    }
    private void addSourceFactoryMethod(ClassWriter writer, String name, String descriptor, String sourceDescriptor, int calls) {
        MethodVisitor method = writer.visitMethod(Opcodes.ACC_PUBLIC, name, descriptor, null, null);
        method.visitCode();
        for (int call = 0; call < calls; call++) {
            method.visitInsn(Opcodes.ACONST_NULL);
            for (Type ignored : Type.getArgumentTypes(sourceDescriptor)) method.visitInsn(Opcodes.ICONST_0);
            method.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "org/webrtc/PeerConnectionFactory", "createVideoSource", sourceDescriptor, false);
            method.visitInsn(Opcodes.POP);
        }
        method.visitInsn(Opcodes.ACONST_NULL);
        method.visitInsn(Opcodes.ARETURN);
        method.visitMaxs(0, 0);
        method.visitEnd();
    }
    @Test public void futureABIBreaksFailTheBuildInsteadOfSilentlySendingMicAsScreenAudio() {
        ClassWriter writer = new ClassWriter(0);
        writer.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, ScreenSharingVisitor.RECORD, null, "java/lang/Object", null);
        writer.visitEnd();
        assertThrows(IllegalStateException.class, () -> transform(ScreenSharingVisitor.RECORD, writer.toByteArray()));
    }
}
