#ifndef TRACER_FRAME_H
#define TRACER_FRAME_H

#include <Python.h>
#include <stdint.h>

typedef struct {
    PyObject_HEAD
    PyFrameObject *f_back;
    void *f_frame;              /* _PyInterpreterFrame* */
    PyObject *f_trace;
    int f_lineno;
    char f_trace_lines;
    char f_trace_opcodes;
    char f_fast_as_locals;
    uint64_t call_id;
} TracerFrameObject;

typedef struct {
    PyCodeObject *f_code;
    void *previous;
    PyObject *f_funcobj;
    PyObject *f_globals;
    PyObject *f_builtins;
    PyObject *f_locals;
    PyFrameObject *frame_obj;
    void *prev_instr;
    int stacktop;
    uint16_t return_offset;
    char owner;
    PyObject *localsplus[1];
} TracerInterpreterFrame;

#endif
