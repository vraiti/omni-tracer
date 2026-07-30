use pyo3::ffi::{PyObject, Py_ssize_t};
use std::ffi::c_int;

#[repr(C)]
pub struct PyFrameObject {
    pub ob_refcnt: Py_ssize_t,
    pub ob_type: *mut PyObject,
    pub f_back: *mut PyFrameObject,
    pub f_frame: *mut u8,
    pub f_trace: *mut PyObject,
    pub f_lineno: c_int,
    pub f_trace_lines: i8,
    pub f_trace_opcodes: i8,
    pub f_fast_as_locals: i8,
    _pad: i8,
    pub call_id: u64,
}

#[inline]
pub unsafe fn get_call_id(frame: *mut PyObject) -> u64 {
    (*(frame as *mut PyFrameObject)).call_id
}

#[inline]
pub unsafe fn set_call_id(frame: *mut PyObject, val: u64) {
    (*(frame as *mut PyFrameObject)).call_id = val;
}

#[inline]
pub unsafe fn set_trace_lines(frame: *mut PyObject, val: i8) {
    (*(frame as *mut PyFrameObject)).f_trace_lines = val;
}
