package com.cove.instrumentation;

import com.android.build.api.instrumentation.*;
import org.objectweb.asm.ClassVisitor;

public abstract class ScreenSharingVisitorFactory implements AsmClassVisitorFactory<InstrumentationParameters.None> {
    @Override public boolean isInstrumentable(ClassData data) {
        String name = data.getClassName().replace('.', '/');
        return name.equals(ScreenSharingVisitor.MODULE)
            || name.equals(ScreenSharingVisitor.OBSERVER)
            || name.equals(ScreenSharingVisitor.CAPTURER)
            || name.equals(ScreenSharingVisitor.RECORD);
    }
    @Override public ClassVisitor createClassVisitor(ClassContext context, ClassVisitor next) {
        return new ScreenSharingVisitor(next, context.getCurrentClassData().getClassName().replace('.', '/'));
    }
}
