use pyo3::prelude::*;
use pyo3::ffi;
use pyo3::types::{PyByteArray, PySet};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::frame;
use crate::records::CallRecord;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

static NEXT_CALL_ID: AtomicU64 = AtomicU64::new(1);
static ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

static mut HOOK_OBJ: *mut ffi::PyObject = std::ptr::null_mut();

// Cached scope prefixes (set once at install, read from trace_func)
static mut PREFIXES: Option<Vec<(String, usize)>> = None;

// Scope cache: filename ptr -> in_scope
static mut SCOPE_CACHE: Option<std::collections::HashMap<usize, bool>> = None;

// ---------------------------------------------------------------------------
// Thread-local frame stack
// ---------------------------------------------------------------------------

struct FrameEntry {
    call_id: u64,
    record: Py<CallRecord>,
    cf_bits: Option<Vec<u64>>,
    cf_max: i32,
    pending_cf: i32,
    branch_buf: Vec<u8>,
}

struct FrameStack {
    entries: Vec<FrameEntry>,
}

impl FrameStack {
    fn new() -> Self {
        Self { entries: Vec::with_capacity(64) }
    }

    fn push(&mut self, entry: FrameEntry) {
        self.entries.push(entry);
    }

    fn peek(&self) -> Option<&FrameEntry> {
        self.entries.last()
    }

    fn peek_mut(&mut self) -> Option<&mut FrameEntry> {
        self.entries.last_mut()
    }

    fn pop(&mut self) -> Option<FrameEntry> {
        self.entries.pop()
    }
}

thread_local! {
    static FRAME_STACK: RefCell<FrameStack> = RefCell::new(FrameStack::new());
}

// ---------------------------------------------------------------------------
// Bitset helpers
// ---------------------------------------------------------------------------

fn set_to_bitset(py: Python<'_>, py_set: &Bound<'_, PySet>) -> (Vec<u64>, i32) {
    let mut max_line: i32 = -1;
    let mut lines: Vec<i32> = Vec::new();

    for item in py_set.iter() {
        if let Ok(v) = item.extract::<i32>() {
            lines.push(v);
            if v > max_line {
                max_line = v;
            }
        }
    }

    if max_line < 0 {
        return (Vec::new(), -1);
    }

    let n_words = (max_line as usize / 64) + 1;
    let mut bits = vec![0u64; n_words];
    for v in lines {
        bits[v as usize / 64] |= 1u64 << (v as usize % 64);
    }
    (bits, max_line)
}

#[inline]
fn bitset_test(bits: &[u64], line: i32) -> bool {
    if line < 0 {
        return false;
    }
    let idx = line as usize / 64;
    if idx >= bits.len() {
        return false;
    }
    (bits[idx] >> (line as usize % 64)) & 1 == 1
}

// ---------------------------------------------------------------------------
// Scope check (from trace_func, using global cached state)
// ---------------------------------------------------------------------------

unsafe fn check_scope(filename_ptr: usize, filename: &str) -> bool {
    let cache = SCOPE_CACHE.as_mut().unwrap();
    if let Some(&cached) = cache.get(&filename_ptr) {
        return cached;
    }
    let prefixes = PREFIXES.as_ref().unwrap();
    let result = prefixes.iter().any(|(p, _)| filename.starts_with(p));
    cache.insert(filename_ptr, result);
    result
}

// ---------------------------------------------------------------------------
// The trace function (Py_tracefunc signature)
// ---------------------------------------------------------------------------

unsafe extern "C" fn trace_func(
    _obj: *mut ffi::PyObject,
    py_frame: *mut ffi::PyFrameObject,
    what: std::ffi::c_int,
    _arg: *mut ffi::PyObject,
) -> std::ffi::c_int {
    if !ENABLED.load(Ordering::Relaxed) {
        return 0;
    }

    let frame_obj = py_frame as *mut ffi::PyObject;
    match what {
        ffi::PyTrace_CALL => handle_call(frame_obj, py_frame),
        ffi::PyTrace_LINE => handle_line(frame_obj, py_frame),
        ffi::PyTrace_RETURN => handle_return(frame_obj, py_frame),
        _ => 0,
    }
}

unsafe fn handle_call(py_frame: *mut ffi::PyObject, frame_obj: *mut ffi::PyFrameObject) -> std::ffi::c_int {
    let code = ffi::PyFrame_GetCode(frame_obj);
    if code.is_null() {
        return 0;
    }

    let filename_obj = (*code).co_filename;
    let filename_ptr = filename_obj as usize;

    let filename = {
        let mut size: ffi::Py_ssize_t = 0;
        let ptr = ffi::PyUnicode_AsUTF8AndSize(filename_obj, &mut size);
        if ptr.is_null() {
            ffi::PyErr_Clear();
            ffi::Py_DECREF(code as *mut ffi::PyObject);
            return 0;
        }
        std::str::from_utf8_unchecked(std::slice::from_raw_parts(
            ptr as *const u8,
            size as usize,
        ))
    };

    let in_scope = check_scope(filename_ptr, filename);

    if !in_scope {
        frame::set_call_id(py_frame, 0);
        frame::set_trace_lines(py_frame, 0);

        // Check for __init__ on tracked class
        let co_name = (*code).co_name;
        let mut name_size: ffi::Py_ssize_t = 0;
        let name_ptr = ffi::PyUnicode_AsUTF8AndSize(co_name, &mut name_size);
        if !name_ptr.is_null() {
            let name = std::str::from_utf8_unchecked(std::slice::from_raw_parts(
                name_ptr as *const u8,
                name_size as usize,
            ));
            if name == "__init__" {
                // Delegate to Python: hook._c_handle_oos_init(frame, call_id, caller_id, call_lineno)
                let call_id = NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed);

                let mut caller_id: u64 = 0;
                let mut call_lineno: std::ffi::c_int = 0;
                let back = ffi::PyFrame_GetBack(py_frame as *mut ffi::PyFrameObject);
                if !back.is_null() {
                    caller_id = frame::get_call_id(back as *mut ffi::PyObject);
                    call_lineno = ffi::PyFrame_GetLineNumber(back);
                    ffi::Py_DECREF(back as *mut ffi::PyObject);
                }

                let hook = HOOK_OBJ;
                if !hook.is_null() {
                    let method = std::ffi::CString::new("_c_handle_oos_init").unwrap();
                    let fmt = std::ffi::CString::new("(OKKi)").unwrap();
                    let result = ffi::PyObject_CallMethod(
                        hook,
                        method.as_ptr(),
                        fmt.as_ptr(),
                        py_frame,
                        call_id,
                        caller_id,
                        call_lineno,
                    );
                    if result.is_null() {
                        ffi::PyErr_Clear();
                    } else if result != ffi::Py_None() {
                        // Got (record, cf_lines) back — push frame
                        frame::set_call_id(py_frame, call_id);
                        frame::set_trace_lines(py_frame, 1);

                        Python::with_gil(|py| {
                            let tuple = Bound::from_borrowed_ptr(py, result);
                            if let (Ok(record), Ok(cf_set)) = (
                                tuple.get_item(0),
                                tuple.get_item(1),
                            ) {
                                let record_py: Py<CallRecord> =
                                    record.extract().unwrap();
                                let (cf_bits, cf_max) =
                                    if let Ok(s) = cf_set.downcast::<PySet>() {
                                        set_to_bitset(py, s)
                                    } else {
                                        (Vec::new(), -1)
                                    };
                                FRAME_STACK.with(|fs| {
                                    fs.borrow_mut().push(FrameEntry {
                                        call_id,
                                        record: record_py,
                                        cf_bits: if cf_max >= 0 {
                                            Some(cf_bits)
                                        } else {
                                            None
                                        },
                                        cf_max,
                                        pending_cf: 0,
                                        branch_buf: Vec::new(),
                                    });
                                });
                            }
                        });
                        ffi::Py_DECREF(result);
                    } else {
                        ffi::Py_DECREF(result);
                    }
                }
            }
        }

        ffi::Py_DECREF(code as *mut ffi::PyObject);
        return 0;
    }

    // In-scope call
    let call_id = NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed);
    frame::set_call_id(py_frame, call_id);

    let mut caller_id: u64 = 0;
    let mut call_lineno: std::ffi::c_int = 0;
    let back = ffi::PyFrame_GetBack(py_frame as *mut ffi::PyFrameObject);
    if !back.is_null() {
        caller_id = frame::get_call_id(back as *mut ffi::PyObject);
        call_lineno = ffi::PyFrame_GetLineNumber(back);
        ffi::Py_DECREF(back as *mut ffi::PyObject);
    }

    // Call Python: hook._c_make_record(frame, call_id, caller_id, call_lineno)
    let hook = HOOK_OBJ;
    if hook.is_null() {
        ffi::Py_DECREF(code as *mut ffi::PyObject);
        return 0;
    }

    let method = std::ffi::CString::new("_c_make_record").unwrap();
    let fmt = std::ffi::CString::new("(OKKi)").unwrap();
    let result = ffi::PyObject_CallMethod(
        hook,
        method.as_ptr(),
        fmt.as_ptr(),
        py_frame,
        call_id,
        caller_id,
        call_lineno,
    );

    if result.is_null() {
        ffi::PyErr_Clear();
        ffi::Py_DECREF(code as *mut ffi::PyObject);
        return 0;
    }

    if result != ffi::Py_None() {
        Python::with_gil(|py| {
            let tuple = Bound::from_borrowed_ptr(py, result);
            if let (Ok(record), Ok(cf_set)) = (
                tuple.get_item(0),
                tuple.get_item(1),
            ) {
                let record_py: Py<CallRecord> = record.extract().unwrap();
                let (cf_bits, cf_max) = if let Ok(s) = cf_set.downcast::<PySet>() {
                    set_to_bitset(py, s)
                } else {
                    (Vec::new(), -1)
                };
                FRAME_STACK.with(|fs| {
                    fs.borrow_mut().push(FrameEntry {
                        call_id,
                        record: record_py,
                        cf_bits: if cf_max >= 0 { Some(cf_bits) } else { None },
                        cf_max,
                        pending_cf: 0,
                        branch_buf: Vec::new(),
                    });
                });
            }
        });
    }

    ffi::Py_DECREF(result);
    ffi::Py_DECREF(code as *mut ffi::PyObject);
    0
}

unsafe fn handle_line(_py_frame: *mut ffi::PyObject, frame_obj: *mut ffi::PyFrameObject) -> std::ffi::c_int {
    let lineno = ffi::PyFrame_GetLineNumber(frame_obj);

    FRAME_STACK.with(|fs| {
        let mut stack = fs.borrow_mut();
        if let Some(entry) = stack.peek_mut() {
            // Resolve pending branch
            if entry.pending_cf > 0 {
                let taken = lineno == entry.pending_cf + 1;
                entry.branch_buf.push(if taken { 1 } else { 0 });
                entry.pending_cf = 0;
            }

            // Check if current line is a CF line
            if let Some(ref bits) = entry.cf_bits {
                if lineno <= entry.cf_max && bitset_test(bits, lineno) {
                    entry.pending_cf = lineno;
                }
            }
        }
    });
    0
}

unsafe fn handle_return(py_frame: *mut ffi::PyObject, _frame_obj: *mut ffi::PyFrameObject) -> std::ffi::c_int {
    let cid = frame::get_call_id(py_frame);
    if cid == 0 {
        return 0;
    }

    FRAME_STACK.with(|fs| {
        let mut stack = fs.borrow_mut();

        // Pop entries until we match this frame's call_id (handles exception unwinding)
        while let Some(entry) = stack.peek_mut() {
            // Resolve pending branch on return
            if entry.pending_cf > 0 {
                entry.branch_buf.push(0);
                entry.pending_cf = 0;
            }

            let entry_cid = entry.call_id;

            // Flush branch buffer to record
            if !entry.branch_buf.is_empty() {
                Python::with_gil(|py| {
                    let ba = PyByteArray::new(py, &entry.branch_buf);
                    let record = entry.record.bind(py);
                    let _ = record.setattr("control_flow", ba);
                });
            }

            stack.pop();
            if entry_cid == cid {
                break;
            }
        }
    });
    0
}

// ---------------------------------------------------------------------------
// Python-visible module functions
// ---------------------------------------------------------------------------

#[pyfunction]
pub fn install(py: Python<'_>, hook: PyObject, prefixes: Vec<String>) -> PyResult<()> {
    unsafe {
        // Store hook reference
        if !HOOK_OBJ.is_null() {
            ffi::Py_DECREF(HOOK_OBJ);
        }
        HOOK_OBJ = hook.into_ptr();

        // Cache prefixes
        let pfx: Vec<(String, usize)> = prefixes
            .iter()
            .map(|s| (s.clone(), s.len()))
            .collect();
        PREFIXES = Some(pfx);
        SCOPE_CACHE = Some(std::collections::HashMap::new());

        NEXT_CALL_ID.store(1, Ordering::Relaxed);
        ENABLED.store(true, Ordering::Relaxed);

        ffi::PyEval_SetTrace(Some(trace_func), HOOK_OBJ);
    }
    Ok(())
}

#[pyfunction]
pub fn install_thread() -> PyResult<()> {
    unsafe {
        if HOOK_OBJ.is_null() {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(
                "tracer not installed",
            ));
        }
        ffi::PyEval_SetTrace(Some(trace_func), HOOK_OBJ);
    }
    Ok(())
}

#[pyfunction]
pub fn uninstall() {
    unsafe {
        ENABLED.store(false, Ordering::Relaxed);
        ffi::PyEval_SetTrace(None, std::ptr::null_mut());
    }
}

#[pyfunction]
pub fn get_call_id(frame: &Bound<'_, PyAny>) -> u64 {
    unsafe { frame::get_call_id(frame.as_ptr()) }
}

#[pyfunction]
pub fn set_call_id(frame: &Bound<'_, PyAny>, cid: u64) {
    unsafe { frame::set_call_id(frame.as_ptr(), cid); }
}

#[pyfunction]
pub fn current_record(py: Python<'_>) -> Option<Py<CallRecord>> {
    FRAME_STACK.with(|fs| {
        let stack = fs.borrow();
        stack.peek().map(|e| e.record.clone_ref(py))
    })
}
