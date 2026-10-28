// JNI entry point that boots the embedded Node.js runtime (nodejs-mobile 18.20.4).
//
// Java side: com.chimatrader.app.NodeService.startNodeWithArguments(String[])
// which is called on a background thread with {"node", "<filesDir>/nodejs-project/main.js"}.
//
// Node's libuv requires all argv strings to live in one contiguous allocation,
// which is what the sample's argument marshalling below does.
#include <jni.h>
#include <string>
#include <cstdlib>
#include <cstring>

#include "node.h"

#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

static const char *ADBTAG = "ChimaTraderNode";

static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;

// Reads from a pipe and mirrors the lines into logcat.
static void *thread_stdout_func(void *) {
    ssize_t redirect_size;
    char buf[2048];
    while ((redirect_size = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
        if (buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
    }
    return nullptr;
}

static void *thread_stderr_func(void *) {
    ssize_t redirect_size;
    char buf[2048];
    while ((redirect_size = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
        if (buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
    }
    return nullptr;
}

static int start_redirecting_stdout_stderr() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (pipe(pipe_stdout) != 0) return -1;
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(pipe_stderr) != 0) return -1;
    dup2(pipe_stderr[1], STDERR_FILENO);

    if (pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr) != 0) return -1;
    pthread_detach(thread_stdout);
    if (pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr) != 0) return -1;
    pthread_detach(thread_stderr);
    return 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_chimatrader_app_NodeService_startNodeWithArguments(
        JNIEnv *env,
        jclass /* clazz */,
        jobjectArray arguments) {

    if (arguments == nullptr) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "startNodeWithArguments: null argv");
        return -1;
    }

    jsize argument_count = env->GetArrayLength(arguments);
    if (argument_count <= 0) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "startNodeWithArguments: empty argv");
        return -1;
    }

    // Total bytes needed for all arguments plus their NUL terminators.
    size_t c_arguments_size = 0;
    for (jsize i = 0; i < argument_count; i += 1) {
        jstring arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(arg, nullptr);
        if (chars != nullptr) {
            c_arguments_size += strlen(chars);
            env->ReleaseStringUTFChars(arg, chars);
        }
        c_arguments_size += 1; // '\0'
        env->DeleteLocalRef(arg);
    }

    char *args_buffer = (char *) calloc(c_arguments_size, sizeof(char));
    if (args_buffer == nullptr) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "startNodeWithArguments: calloc failed");
        return -1;
    }

    char *argv[argument_count];
    char *cursor = args_buffer;
    for (jsize i = 0; i < argument_count; i += 1) {
        jstring arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(arg, nullptr);
        size_t len = chars == nullptr ? 0 : strlen(chars);
        if (len > 0) memcpy(cursor, chars, len);
        if (chars != nullptr) env->ReleaseStringUTFChars(arg, chars);
        env->DeleteLocalRef(arg);
        argv[i] = cursor;
        cursor += len + 1;
    }

    if (start_redirecting_stdout_stderr() == -1) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "could not redirect stdout/stderr to logcat");
    }

    __android_log_write(ANDROID_LOG_INFO, ADBTAG, "calling node::Start");
    jint result = (jint) node::Start(argument_count, argv);
    free(args_buffer);
    __android_log_print(ANDROID_LOG_INFO, ADBTAG, "node::Start returned %d", (int) result);
    return result;
}
