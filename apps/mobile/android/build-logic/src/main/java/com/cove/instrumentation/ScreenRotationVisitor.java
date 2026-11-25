package com.cove.instrumentation;

import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/** Use the display-aware controller for the screen track in react-native-webrtc. */
final class ScreenRotationVisitor extends ClassVisitor {
    static final String BASE = "com/oney/WebRTCModule/ScreenCaptureController";
    static final String CONTROLLER = "com/oney/WebRTCModule/CoveScreenCaptureController";
    static final String CONSTRUCTOR = "(Landroid/content/Context;IILandroid/content/Intent;F)V";
    private int allocations;
    private int constructors;

    ScreenRotationVisitor(ClassVisitor next) {
        super(Opcodes.ASM9, next);
    }

    @Override public MethodVisitor visitMethod(int access, String name, String desc,
            String signature, String[] exceptions) {
        MethodVisitor next = super.visitMethod(access, name, desc, signature, exceptions);
        if (!name.equals("createScreenTrack") || !desc.equals("()Lorg/webrtc/VideoTrack;")) return next;
        return new MethodVisitor(Opcodes.ASM9, next) {
            @Override public void visitTypeInsn(int opcode, String type) {
                if (opcode == Opcodes.NEW && type.equals(BASE)) {
                    allocations++;
                    type = CONTROLLER;
                }
                super.visitTypeInsn(opcode, type);
            }

            @Override public void visitMethodInsn(int opcode, String owner, String method,
                    String descriptor, boolean iface) {
                if (owner.equals(BASE) && method.equals("<init>")) {
                    if (opcode != Opcodes.INVOKESPECIAL || iface || !descriptor.equals(CONSTRUCTOR)) {
                        throw new IllegalStateException("Screen capture controller constructor ABI changed");
                    }
                    constructors++;
                    owner = CONTROLLER;
                }
                super.visitMethodInsn(opcode, owner, method, descriptor, iface);
            }
        };
    }

    @Override public void visitEnd() {
        if (allocations != 1 || constructors != 1) {
            throw new IllegalStateException("Expected one screen capture controller in createScreenTrack");
        }
        super.visitEnd();
    }
}
