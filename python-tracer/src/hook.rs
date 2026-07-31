use pyo3::prelude::*;
use pyo3::ffi;
use pyo3::types::{PyByteArray, PySet};
use std::collections::HashMap;

use crate::frame;
use crate::filter::PathFilter;
use crate::ownership::OwnershipHook;
use crate::records::{CallRecord, Database, ObjectRecord};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

static mut NEXT_CALL_ID: u64 = 1;
static mut ENABLED: bool = false;

static mut HOOK_OBJ: *mut ffi::PyObject = std::ptr::null_mut();
static mut DB_OBJ: Option<Py<Database>> = None;
static mut OWNERSHIP_OBJ: Option<Py<OwnershipHook>> = None;
static mut FILTER_OBJ: Option<Py<PathFilter>> = None;

// Cached scope prefixes (set once at install, read from trace_func)
static mut PREFIXES: Option<Vec<(String, usize)>> = None;

// Scope cache: filename ptr -> in_scope
static mut SCOPE_CACHE: Option<std::collections::HashMap<usize, bool>> = None;

// Taint patterns: qualname substrings that suppress tracing
static mut TAINT_PATTERNS: Option<Vec<String>> = None;

// AST data: function IDs and control flow bitsets, transferred from Python at startup
struct AstData {
    func_to_id: HashMap<String, i32>,
    next_func_id: i32,
    cf_bits: HashMap<String, Vec<u64>>,
    cf_max: HashMap<String, i32>,
}
static mut AST_DATA: Option<AstData> = None;

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

static mut FRAME_STACK: Option<FrameStack> = None;

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
    if !ENABLED {
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
    // Taint propagation: if caller is tainted, propagate without tracing
    let back = ffi::PyFrame_GetBack(frame_obj);
    if !back.is_null() {
        let caller_id = frame::get_call_id(back as *mut ffi::PyObject);
        ffi::Py_DECREF(back as *mut ffi::PyObject);
        if caller_id == u64::MAX {
            frame::set_call_id(py_frame, u64::MAX);
            frame::set_trace_lines(py_frame, 0);
            return 0;
        }
    }

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

    // Taint origination: check if this function matches a taint pattern
    if let Some(ref patterns) = TAINT_PATTERNS {
        if !patterns.is_empty() {
            let qualname_obj = (*code).co_qualname;
            let mut qn_size: ffi::Py_ssize_t = 0;
            let qn_ptr = ffi::PyUnicode_AsUTF8AndSize(qualname_obj, &mut qn_size);
            if !qn_ptr.is_null() {
                let qualname = std::str::from_utf8_unchecked(std::slice::from_raw_parts(
                    qn_ptr as *const u8,
                    qn_size as usize,
                ));
                if patterns.iter().any(|p| qualname.contains(p.as_str())) {
                    frame::set_call_id(py_frame, u64::MAX);
                    frame::set_trace_lines(py_frame, 0);
                    ffi::Py_DECREF(code as *mut ffi::PyObject);
                    return 0;
                }
            }
        }
    }

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
                let (self_obj, _) = get_self_obj_id(py_frame, code);
                // BISECT: return after get_self_obj_id
                ffi::Py_DECREF(code as *mut ffi::PyObject);
                return 0;
                if let Some(self_ptr) = self_obj {
                    let py = Python::assume_gil_acquired();
                    let should_trace = if let Some(ref filter) = FILTER_OBJ {
                        let self_bound = Bound::from_borrowed_ptr(py, self_ptr);
                        let cls = self_bound.get_type();
                        filter.borrow(py).is_tracked_class(&cls)
                    } else {
                        false
                    };

                    if should_trace {
                        let call_id = { let id = NEXT_CALL_ID; NEXT_CALL_ID += 1; id };

                        let mut caller_id: u64 = 0;
                        let mut call_lineno: std::ffi::c_int = 0;
                        let back = ffi::PyFrame_GetBack(py_frame as *mut ffi::PyFrameObject);
                        if !back.is_null() {
                            caller_id = frame::get_call_id(back as *mut ffi::PyObject);
                            call_lineno = ffi::PyFrame_GetLineNumber(back);
                            ffi::Py_DECREF(back as *mut ffi::PyObject);
                        }

                        // Extract qualname for ref_str
                        let qualname_obj = (*code).co_qualname;
                        let mut qn_size: ffi::Py_ssize_t = 0;
                        let qn_ptr = ffi::PyUnicode_AsUTF8AndSize(qualname_obj, &mut qn_size);
                        if !qn_ptr.is_null() {
                            let qualname = std::str::from_utf8_unchecked(std::slice::from_raw_parts(
                                qn_ptr as *const u8,
                                qn_size as usize,
                            ));
                            let ref_str = format!("{}:{}", filename, qualname);
                            let function_id = get_or_assign_function_id(&ref_str);

                            let obj_id = 0i32;

                            frame::set_call_id(py_frame, call_id);
                            frame::set_trace_lines(py_frame, 1);

                            let db = DB_OBJ.as_ref().unwrap();
                            let rec = Py::new(py, CallRecord::new(py, call_id, function_id, caller_id as u64, call_lineno, obj_id)).unwrap();
                            let _ = db.borrow(py).add_call(py, rec.clone_ref(py));

                            handle_init_rust(py, self_ptr, code, call_id);
                            let tr_idx_key = std::ffi::CStr::from_bytes_with_nul_unchecked(b"__tr_idx\0");
                            let tr_idx = ffi::PyObject_GetAttrString(self_ptr, tr_idx_key.as_ptr());
                            if !tr_idx.is_null() {
                                let new_id = ffi::PyLong_AsLong(tr_idx) as i32;
                                ffi::Py_DECREF(tr_idx);
                                if new_id != -1 || ffi::PyErr_Occurred().is_null() {
                                    rec.borrow_mut(py).obj_id = new_id;
                                } else {
                                    ffi::PyErr_Clear();
                                }
                            } else {
                                ffi::PyErr_Clear();
                            }

                            let data = AST_DATA.as_ref().unwrap();
                            let (cf_bits_vec, cf_max_val) = if let Some(bits) = data.cf_bits.get(&ref_str) {
                                let max = *data.cf_max.get(&ref_str).unwrap_or(&-1);
                                (bits.clone(), max)
                            } else {
                                (Vec::new(), -1)
                            };

                            FRAME_STACK.as_mut().unwrap().push(FrameEntry {
                                call_id,
                                record: rec,
                                cf_bits: if cf_max_val >= 0 { Some(cf_bits_vec) } else { None },
                                cf_max: cf_max_val,
                                pending_cf: 0,
                                branch_buf: Vec::new(),
                            });
                        }
                    }
                }
            }
        }

        ffi::Py_DECREF(code as *mut ffi::PyObject);
        return 0;
    }

    // In-scope call
    let call_id = { let id = NEXT_CALL_ID; NEXT_CALL_ID += 1; id };
    frame::set_call_id(py_frame, call_id);

    let mut caller_id: u64 = 0;
    let mut call_lineno: std::ffi::c_int = 0;
    let back = ffi::PyFrame_GetBack(py_frame as *mut ffi::PyFrameObject);
    if !back.is_null() {
        caller_id = frame::get_call_id(back as *mut ffi::PyObject);
        call_lineno = ffi::PyFrame_GetLineNumber(back);
        ffi::Py_DECREF(back as *mut ffi::PyObject);
    }

    // Extract co_qualname for ref_str
    let qualname_obj = (*code).co_qualname;
    let mut qn_size: ffi::Py_ssize_t = 0;
    let qn_ptr = ffi::PyUnicode_AsUTF8AndSize(qualname_obj, &mut qn_size);
    if qn_ptr.is_null() {
        ffi::PyErr_Clear();
        ffi::Py_DECREF(code as *mut ffi::PyObject);
        return 0;
    }
    let qualname = std::str::from_utf8_unchecked(std::slice::from_raw_parts(
        qn_ptr as *const u8,
        qn_size as usize,
    ));

    let ref_str = format!("{}:{}", filename, qualname);
    let function_id = get_or_assign_function_id(&ref_str);

    let (self_obj, mut obj_id) = get_self_obj_id(py_frame, code);

    let py = Python::assume_gil_acquired();
    let db = DB_OBJ.as_ref().unwrap();
    let rec = Py::new(py, CallRecord::new(py, call_id, function_id, caller_id as u64, call_lineno, obj_id)).unwrap();
    let _ = db.borrow(py).add_call(py, rec.clone_ref(py));

    let co_name = (*code).co_name;
    let mut name_size: ffi::Py_ssize_t = 0;
    let name_ptr = ffi::PyUnicode_AsUTF8AndSize(co_name, &mut name_size);
    if !name_ptr.is_null() && self_obj.is_some() {
        let name = std::str::from_utf8_unchecked(std::slice::from_raw_parts(
            name_ptr as *const u8,
            name_size as usize,
        ));
        if name == "__init__" {
            handle_init_rust(py, self_obj.unwrap(), code, call_id);
            let tr_idx_key = std::ffi::CStr::from_bytes_with_nul_unchecked(b"__tr_idx\0");
            let tr_idx = ffi::PyObject_GetAttrString(self_obj.unwrap(), tr_idx_key.as_ptr());
            if !tr_idx.is_null() {
                let new_id = ffi::PyLong_AsLong(tr_idx) as i32;
                ffi::Py_DECREF(tr_idx);
                if new_id != -1 || ffi::PyErr_Occurred().is_null() {
                    obj_id = new_id;
                    rec.borrow_mut(py).obj_id = obj_id;
                } else {
                    ffi::PyErr_Clear();
                }
            } else {
                ffi::PyErr_Clear();
            }
        }
    }

    let data = AST_DATA.as_ref().unwrap();
    let (cf_bits_vec, cf_max_val) = if let Some(bits) = data.cf_bits.get(&ref_str) {
        let max = *data.cf_max.get(&ref_str).unwrap_or(&-1);
        (bits.clone(), max)
    } else {
        (Vec::new(), -1)
    };

    FRAME_STACK.as_mut().unwrap().push(FrameEntry {
        call_id,
        record: rec,
        cf_bits: if cf_max_val >= 0 { Some(cf_bits_vec) } else { None },
        cf_max: cf_max_val,
        pending_cf: 0,
        branch_buf: Vec::new(),
    });

    // Enable line tracing for this frame
    frame::set_trace_lines(py_frame, 1);
    ffi::Py_DECREF(code as *mut ffi::PyObject);
    0
}

unsafe fn handle_line(_py_frame: *mut ffi::PyObject, frame_obj: *mut ffi::PyFrameObject) -> std::ffi::c_int {
    let lineno = ffi::PyFrame_GetLineNumber(frame_obj);

    let stack = FRAME_STACK.as_mut().unwrap();
    if let Some(entry) = stack.peek_mut() {
        if entry.pending_cf > 0 {
            let taken = lineno == entry.pending_cf + 1;
            entry.branch_buf.push(if taken { 1 } else { 0 });
            entry.pending_cf = 0;
        }
        if let Some(ref bits) = entry.cf_bits {
            if lineno <= entry.cf_max && bitset_test(bits, lineno) {
                entry.pending_cf = lineno;
            }
        }
    }
    0
}

unsafe fn handle_return(py_frame: *mut ffi::PyObject, _frame_obj: *mut ffi::PyFrameObject) -> std::ffi::c_int {
    let cid = frame::get_call_id(py_frame);
    if cid == 0 || cid == u64::MAX {
        return 0;
    }

    let stack = FRAME_STACK.as_mut().unwrap();
    while let Some(entry) = stack.peek_mut() {
        if entry.pending_cf > 0 {
            entry.branch_buf.push(0);
            entry.pending_cf = 0;
        }

        let entry_cid = entry.call_id;

        if !entry.branch_buf.is_empty() {
            let py = Python::assume_gil_acquired();
            let ba = PyByteArray::new(py, &entry.branch_buf);
            let record = entry.record.bind(py);
            let _ = record.setattr("control_flow", ba);
        }

        stack.pop();
        if entry_cid == cid {
            break;
        }
    }
    0
}

// ---------------------------------------------------------------------------
// Python-visible module functions
// ---------------------------------------------------------------------------

#[pyfunction]
#[pyo3(signature = (hook, prefixes, db, ownership, path_filter, taint_patterns=None))]
pub fn install(
    py: Python<'_>,
    hook: PyObject,
    prefixes: Vec<String>,
    db: Py<Database>,
    ownership: Py<OwnershipHook>,
    path_filter: Py<PathFilter>,
    taint_patterns: Option<Vec<String>>,
) -> PyResult<()> {
    unsafe {
        if !HOOK_OBJ.is_null() {
            ffi::Py_DECREF(HOOK_OBJ);
        }
        HOOK_OBJ = hook.into_ptr();

        DB_OBJ = Some(db);
        OWNERSHIP_OBJ = Some(ownership);
        FILTER_OBJ = Some(path_filter);

        let pfx: Vec<(String, usize)> = prefixes
            .iter()
            .map(|s| (s.clone(), s.len()))
            .collect();
        PREFIXES = Some(pfx);
        SCOPE_CACHE = Some(std::collections::HashMap::new());
        TAINT_PATTERNS = taint_patterns.map(|v| v.into_iter().filter(|s| !s.is_empty()).collect());

        NEXT_CALL_ID = 1;
        FRAME_STACK = Some(FrameStack::new());
        ENABLED = true;

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
        ENABLED = false;
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
    unsafe {
        FRAME_STACK.as_ref().and_then(|s| s.peek().map(|e| e.record.clone_ref(py)))
    }
}

fn hashset_to_bitset(lines: &std::collections::HashSet<i32>) -> (Vec<u64>, i32) {
    let mut max_line: i32 = -1;
    for &v in lines {
        if v > max_line {
            max_line = v;
        }
    }
    if max_line < 0 {
        return (Vec::new(), -1);
    }
    let n_words = (max_line as usize / 64) + 1;
    let mut bits = vec![0u64; n_words];
    for &v in lines {
        bits[v as usize / 64] |= 1u64 << (v as usize % 64);
    }
    (bits, max_line)
}

#[pyfunction]
pub fn load_ast_data(func_map: HashMap<String, i32>, cf_lines: HashMap<String, std::collections::HashSet<i32>>) {
    let next_id = func_map.values().copied().max().unwrap_or(-1) + 1;
    let mut cf_bits_map = HashMap::with_capacity(cf_lines.len());
    let mut cf_max_map = HashMap::with_capacity(cf_lines.len());
    for (ref_str, lines) in &cf_lines {
        let (bits, max) = hashset_to_bitset(lines);
        if max >= 0 {
            cf_bits_map.insert(ref_str.clone(), bits);
            cf_max_map.insert(ref_str.clone(), max);
        }
    }
    unsafe {
        AST_DATA = Some(AstData {
            func_to_id: func_map,
            next_func_id: next_id,
            cf_bits: cf_bits_map,
            cf_max: cf_max_map,
        });
    }
}

#[pyfunction]
pub fn get_func_map() -> HashMap<String, i32> {
    unsafe {
        AST_DATA.as_ref().map(|d| d.func_to_id.clone()).unwrap_or_default()
    }
}

unsafe fn get_or_assign_function_id(ref_str: &str) -> i32 {
    let data = AST_DATA.as_mut().unwrap();
    if let Some(&id) = data.func_to_id.get(ref_str) {
        return id;
    }
    let id = data.next_func_id;
    data.next_func_id += 1;
    data.func_to_id.insert(ref_str.to_string(), id);
    id
}

const LOCALSPLUS_OFFSET: usize = 72;

unsafe fn get_self_obj_id(py_frame: *mut ffi::PyObject, code: *mut ffi::PyCodeObject) -> (Option<*mut ffi::PyObject>, i32) {
    if (*code).co_argcount < 1 {
        return (None, 0);
    }
    let frame = py_frame as *mut frame::PyFrameObject;
    let f_frame = (*frame).f_frame;
    if f_frame.is_null() {
        return (None, 0);
    }
    let localsplus = f_frame.add(LOCALSPLUS_OFFSET) as *const *mut ffi::PyObject;
    let self_obj = *localsplus;
    if self_obj.is_null() {
        return (None, 0);
    }
    let tr_idx_key = std::ffi::CStr::from_bytes_with_nul_unchecked(b"__tr_idx\0");
    let tr_idx = ffi::PyObject_GetAttrString(self_obj, tr_idx_key.as_ptr());
    if tr_idx.is_null() {
        ffi::PyErr_Clear();
        return (Some(self_obj), 0);
    }
    let obj_id = ffi::PyLong_AsLong(tr_idx) as i32;
    ffi::Py_DECREF(tr_idx);
    if obj_id == -1 && !ffi::PyErr_Occurred().is_null() {
        ffi::PyErr_Clear();
        return (Some(self_obj), 0);
    }
    (Some(self_obj), obj_id)
}

unsafe fn handle_init_rust(
    py: Python<'_>,
    self_obj: *mut ffi::PyObject,
    code: *mut ffi::PyCodeObject,
    call_id: u64,
) {
    let cls = ffi::Py_TYPE(self_obj);
    if cls.is_null() {
        return;
    }

    let init_name = std::ffi::CStr::from_bytes_with_nul_unchecked(b"__init__\0");
    let cls_init = ffi::PyObject_GetAttrString(cls as *mut ffi::PyObject, init_name.as_ptr());
    if cls_init.is_null() {
        ffi::PyErr_Clear();
        return;
    }

    let code_attr = std::ffi::CStr::from_bytes_with_nul_unchecked(b"__code__\0");
    let cls_code = ffi::PyObject_GetAttrString(cls_init, code_attr.as_ptr());
    ffi::Py_DECREF(cls_init);
    if cls_code.is_null() {
        ffi::PyErr_Clear();
        return;
    }

    let matches = cls_code as *mut ffi::PyCodeObject == code;
    ffi::Py_DECREF(cls_code);
    if !matches {
        return;
    }

    let db = DB_OBJ.as_ref().unwrap();
    let obj_rec = Py::new(py, ObjectRecord::new(py, call_id)).unwrap();
    let obj_idx = db.borrow(py).add_object(py, obj_rec).unwrap();

    let idx_obj = ffi::PyLong_FromLong(obj_idx as std::ffi::c_long);
    let tr_idx_key = std::ffi::CStr::from_bytes_with_nul_unchecked(b"__tr_idx\0");
    ffi::PyObject_GenericSetAttr(
        self_obj,
        ffi::PyUnicode_InternFromString(tr_idx_key.as_ptr()),
        idx_obj,
    );
    ffi::Py_DECREF(idx_obj);

    if let Some(ref ownership) = OWNERSHIP_OBJ {
        let cls_bound = Bound::from_borrowed_ptr(py, cls as *mut ffi::PyObject);
        if let Ok(cls_type) = cls_bound.downcast::<pyo3::types::PyType>() {
            let _ = ownership.borrow_mut(py).patch_class(py, cls_type);
        }
    }
}
