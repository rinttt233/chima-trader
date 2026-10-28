# Builds the small JNI shim that boots the embedded Node runtime.
# The nodejs-mobile prebuilt library and headers live in app/libnode (CI download).
cmake_minimum_required(VERSION 3.22.1)

project(chima-native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# libnode's public headers (node.h -> v8.h ...), provided by nodejs-mobile.
include_directories(libnode/include/node/)

add_library(libnode SHARED IMPORTED)
set_target_properties(
        libnode
        PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED src/main/cpp/native-lib.cpp)

find_library(log-lib log)

target_link_libraries(native-lib libnode ${log-lib})
