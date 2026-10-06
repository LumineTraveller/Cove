package com.cove.instrumentation;

import com.android.build.api.instrumentation.FramesComputationMode;
import com.android.build.api.instrumentation.InstrumentationParameters;
import com.android.build.api.instrumentation.InstrumentationScope;
import com.android.build.api.variant.ApplicationAndroidComponentsExtension;
import org.gradle.api.Plugin;
import org.gradle.api.Project;

public final class CoveAndroidInstrumentationPlugin implements Plugin<Project> {
    @Override
    public void apply(Project project) {
        project.getPluginManager().withPlugin("com.android.application", ignored -> {
            ApplicationAndroidComponentsExtension androidComponents =
                project.getExtensions().getByType(ApplicationAndroidComponentsExtension.class);
            androidComponents.onVariants(androidComponents.selector().all(), variant -> {
                variant.getInstrumentation().transformClassesWith(
                    RecordedAudioVisitorFactory.class,
                    InstrumentationScope.ALL,
                    parameters -> kotlin.Unit.INSTANCE
                );
                variant.getInstrumentation().transformClassesWith(
                    ScreenSharingVisitorFactory.class,
                    InstrumentationScope.ALL,
                    parameters -> kotlin.Unit.INSTANCE
                );
                variant.getInstrumentation().setAsmFramesComputationMode(
                    FramesComputationMode.COMPUTE_FRAMES_FOR_INSTRUMENTED_METHODS
                );
            });
        });
    }
}
