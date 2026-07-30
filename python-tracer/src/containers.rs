use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyString};
use std::collections::HashMap;

use crate::frame;
use crate::hook;
use crate::records::{AttrRecordRead, AttrRecordWrite, Database};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn caller_arw(py: Python<'_>) -> AttrRecordWrite {
    let frame_ptr = unsafe { pyo3::ffi::PyEval_GetFrame() };
    if frame_ptr.is_null() {
        return AttrRecordWrite::new(0, 0);
    }
    let caller_id = unsafe { frame::get_call_id(frame_ptr as *mut pyo3::ffi::PyObject) };
    let lineno = unsafe { pyo3::ffi::PyFrame_GetLineNumber(frame_ptr) };
    AttrRecordWrite::new(caller_id, lineno)
}

fn emit_read(py: Python<'_>, arw: &AttrRecordWrite) {
    let frame_ptr = unsafe { pyo3::ffi::PyEval_GetFrame() };
    if frame_ptr.is_null() {
        return;
    }
    if let Some(rec) = hook::current_record(py) {
        let caller_id = unsafe { frame::get_call_id(frame_ptr as *mut pyo3::ffi::PyObject) };
        let lineno = unsafe { pyo3::ffi::PyFrame_GetLineNumber(frame_ptr) };
        let read = AttrRecordRead::new(caller_id, arw.call_lineno, lineno);
        let record = rec.bind(py);
        if let Ok(attr_reads) = record.getattr("attr_reads") {
            let _ = attr_reads.call_method1("append", (read,));
        }
    }
}

// ---------------------------------------------------------------------------
// TracedDict
// ---------------------------------------------------------------------------

#[pyclass(module = "tracer._tracer")]
pub struct TracedDict {
    inner: Py<PyDict>,
    arws: HashMap<u64, AttrRecordWrite>, // keyed by hash of the key object
    db: Py<Database>,
    trace_hook: PyObject,
    #[pyo3(get)]
    _tr_wrapped: bool,
}

impl TracedDict {
    fn key_hash(py: Python<'_>, key: &Bound<'_, PyAny>) -> u64 {
        key.hash().unwrap_or(key.as_ptr() as isize) as u64
    }
}

#[pymethods]
impl TracedDict {
    #[new]
    #[pyo3(signature = (source, db, trace_hook, owner_idx, attr))]
    fn new(
        py: Python<'_>,
        source: &Bound<'_, PyDict>,
        db: Py<Database>,
        trace_hook: PyObject,
        owner_idx: i32,
        attr: &str,
    ) -> PyResult<Self> {
        let copy = source.copy()?;
        let mut arws = HashMap::new();
        for key in copy.keys() {
            let h = Self::key_hash(py, &key);
            arws.insert(h, AttrRecordWrite::new(0, 0));
        }
        Ok(Self {
            inner: copy.unbind(),
            arws,
            db,
            trace_hook,
            _tr_wrapped: true,
        })
    }

    fn __setitem__(&mut self, py: Python<'_>, key: &Bound<'_, PyAny>, value: &Bound<'_, PyAny>) -> PyResult<()> {
        self.inner.bind(py).set_item(key, value)?;
        let h = Self::key_hash(py, key);
        self.arws.insert(h, caller_arw(py));
        Ok(())
    }

    fn __getitem__(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<PyObject> {
        let result = self.inner.bind(py).get_item(key)?;
        match result {
            Some(val) => {
                let h = Self::key_hash(py, key);
                if let Some(arw) = self.arws.get(&h) {
                    emit_read(py, arw);
                }
                Ok(val.unbind())
            }
            None => Err(pyo3::exceptions::PyKeyError::new_err("key not found")),
        }
    }

    fn __delitem__(&mut self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<()> {
        self.inner.bind(py).del_item(key)?;
        let h = Self::key_hash(py, key);
        self.arws.remove(&h);
        Ok(())
    }

    fn __contains__(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<bool> {
        self.inner.bind(py).contains(key)
    }

    fn __len__(&self, py: Python<'_>) -> usize {
        self.inner.bind(py).len()
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(format!("TracedDict({})", self.inner.bind(py).repr()?))
    }

    fn __iter__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let iter = self.inner.bind(py).call_method0("__iter__")?;
        Ok(iter.unbind())
    }

    #[pyo3(signature = (key, default=None))]
    fn get(&self, py: Python<'_>, key: &Bound<'_, PyAny>, default: Option<&Bound<'_, PyAny>>) -> PyResult<PyObject> {
        let dict = self.inner.bind(py);
        match dict.get_item(key)? {
            Some(val) => {
                let h = Self::key_hash(py, key);
                if let Some(arw) = self.arws.get(&h) {
                    emit_read(py, arw);
                }
                Ok(val.unbind())
            }
            None => Ok(default.map(|d| d.clone().unbind()).unwrap_or_else(|| py.None())),
        }
    }

    #[pyo3(signature = (*args))]
    fn pop(&mut self, py: Python<'_>, args: &Bound<'_, pyo3::types::PyTuple>) -> PyResult<PyObject> {
        let key = args.get_item(0)?;
        let h = Self::key_hash(py, &key);
        if let Some(arw) = self.arws.get(&h) {
            emit_read(py, arw);
        }
        let result = self.inner.bind(py).call_method1("pop", args)?;
        self.arws.remove(&h);
        Ok(result.unbind())
    }

    #[pyo3(signature = (*args, **kwargs))]
    fn update(&mut self, py: Python<'_>, args: &Bound<'_, pyo3::types::PyTuple>, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        let dict = self.inner.bind(py);
        if args.len() > 0 {
            dict.call_method1("update", args)?;
        }
        if let Some(kw) = kwargs {
            dict.call_method1("update", (kw,))?;
        }
        let arw = caller_arw(py);
        // Re-scan keys that were updated
        for key in dict.keys() {
            let h = Self::key_hash(py, &key);
            self.arws.entry(h).or_insert_with(|| arw.clone());
        }
        Ok(())
    }

    #[pyo3(signature = (key, default=None))]
    fn setdefault(&mut self, py: Python<'_>, key: &Bound<'_, PyAny>, default: Option<&Bound<'_, PyAny>>) -> PyResult<PyObject> {
        let dict = self.inner.bind(py);
        if dict.contains(key)? {
            return self.__getitem__(py, key);
        }
        let val = default.map(|d| d.clone().unbind()).unwrap_or_else(|| py.None());
        let val_bound = val.bind(py);
        self.__setitem__(py, key, val_bound)?;
        Ok(val)
    }

    fn clear(&mut self, py: Python<'_>) -> PyResult<()> {
        self.inner.bind(py).call_method0("clear")?;
        self.arws.clear();
        Ok(())
    }

    fn keys(&self, py: Python<'_>) -> PyResult<PyObject> {
        Ok(self.inner.bind(py).keys().unbind().into())
    }

    fn values(&self, py: Python<'_>) -> PyResult<PyObject> {
        Ok(self.inner.bind(py).values().unbind().into())
    }

    fn items(&self, py: Python<'_>) -> PyResult<PyObject> {
        Ok(self.inner.bind(py).items().unbind().into())
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let builtins = py.import("builtins")?;
        let dict_type = builtins.getattr("dict")?;
        let items = self.inner.bind(py).items();
        let args = pyo3::types::PyTuple::new(py, &[items.as_any()])?;
        let result = pyo3::types::PyTuple::new(py, &[dict_type.as_any(), args.as_any()])?;
        Ok(result.unbind().into())
    }
}

// ---------------------------------------------------------------------------
// TracedList
// ---------------------------------------------------------------------------

#[pyclass(module = "tracer._tracer")]
pub struct TracedList {
    inner: Py<PyList>,
    arws: Vec<AttrRecordWrite>,
    db: Py<Database>,
    trace_hook: PyObject,
    #[pyo3(get)]
    _tr_wrapped: bool,
}

#[pymethods]
impl TracedList {
    #[new]
    #[pyo3(signature = (source, db, trace_hook, owner_idx, attr))]
    fn new(
        py: Python<'_>,
        source: &Bound<'_, PyList>,
        db: Py<Database>,
        trace_hook: PyObject,
        owner_idx: i32,
        attr: &str,
    ) -> PyResult<Self> {
        let copy = source.call_method0("copy")?;
        let list: Bound<'_, PyList> = copy.downcast_into()?;
        let arws = vec![AttrRecordWrite::new(0, 0); list.len()];
        Ok(Self {
            inner: list.unbind(),
            arws,
            db,
            trace_hook,
            _tr_wrapped: true,
        })
    }

    fn __len__(&self, py: Python<'_>) -> usize {
        self.inner.bind(py).len()
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(format!("TracedList({})", self.inner.bind(py).repr()?))
    }

    fn __iter__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let iter = self.inner.bind(py).call_method0("__iter__")?;
        Ok(iter.unbind())
    }

    fn __setitem__(&mut self, py: Python<'_>, index: isize, value: &Bound<'_, PyAny>) -> PyResult<()> {
        let len = self.inner.bind(py).len();
        let idx = if index < 0 { (len as isize + index) as usize } else { index as usize };
        self.inner.bind(py).set_item(idx, value)?;
        if idx < self.arws.len() {
            self.arws[idx] = caller_arw(py);
        }
        Ok(())
    }

    fn __getitem__(&self, py: Python<'_>, index: isize) -> PyResult<PyObject> {
        let len = self.inner.bind(py).len();
        let idx = if index < 0 { (len as isize + index) as usize } else { index as usize };
        let result = self.inner.bind(py).get_item(idx)?;
        if idx < self.arws.len() {
            emit_read(py, &self.arws[idx]);
        }
        Ok(result.unbind())
    }

    fn append(&mut self, py: Python<'_>, value: &Bound<'_, PyAny>) -> PyResult<()> {
        self.inner.bind(py).append(value)?;
        self.arws.push(caller_arw(py));
        Ok(())
    }

    fn extend(&mut self, py: Python<'_>, values: &Bound<'_, PyAny>) -> PyResult<()> {
        let arw = caller_arw(py);
        let start = self.inner.bind(py).len();
        self.inner.bind(py).call_method1("extend", (values,))?;
        let new_len = self.inner.bind(py).len();
        for _ in start..new_len {
            self.arws.push(arw.clone());
        }
        Ok(())
    }

    fn insert(&mut self, py: Python<'_>, index: isize, value: &Bound<'_, PyAny>) -> PyResult<()> {
        let len = self.inner.bind(py).len();
        let idx = if index < 0 {
            (len as isize + 1 + index).max(0) as usize
        } else {
            (index as usize).min(len)
        };
        self.inner.bind(py).insert(idx, value)?;
        self.arws.insert(idx, caller_arw(py));
        Ok(())
    }

    #[pyo3(signature = (index=-1))]
    fn pop(&mut self, py: Python<'_>, index: isize) -> PyResult<PyObject> {
        let len = self.arws.len();
        let idx = if index < 0 { (len as isize + index) as usize } else { index as usize };
        if idx < len {
            emit_read(py, &self.arws[idx]);
            self.arws.remove(idx);
        }
        let result = self.inner.bind(py).call_method1("pop", (index,))?;
        Ok(result.unbind())
    }

    fn remove(&mut self, py: Python<'_>, value: &Bound<'_, PyAny>) -> PyResult<()> {
        let list = self.inner.bind(py);
        let idx: usize = list.call_method1("index", (value,))?.extract()?;
        if idx < self.arws.len() {
            self.arws.remove(idx);
        }
        list.call_method1("remove", (value,))?;
        Ok(())
    }

    fn clear(&mut self, py: Python<'_>) -> PyResult<()> {
        self.inner.bind(py).call_method0("clear")?;
        self.arws.clear();
        Ok(())
    }

    fn copy(&self, py: Python<'_>) -> PyResult<PyObject> {
        let list = self.inner.bind(py);
        let copied = list.call_method0("copy")?;
        Ok(copied.unbind())
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let builtins = py.import("builtins")?;
        let list_type = builtins.getattr("list")?;
        let inner = self.inner.bind(py);
        let args = pyo3::types::PyTuple::new(py, &[inner.as_any()])?;
        let result = pyo3::types::PyTuple::new(py, &[list_type.as_any(), args.as_any()])?;
        Ok(result.unbind().into())
    }
}

// ---------------------------------------------------------------------------
// TracedDeque
// ---------------------------------------------------------------------------

#[pyclass(module = "tracer._tracer")]
pub struct TracedDeque {
    inner: PyObject,
    arws: std::collections::VecDeque<AttrRecordWrite>,
    db: Py<Database>,
    trace_hook: PyObject,
    #[pyo3(get)]
    _tr_wrapped: bool,
}

#[pymethods]
impl TracedDeque {
    #[new]
    #[pyo3(signature = (source, db, trace_hook, owner_idx, attr))]
    fn new(
        py: Python<'_>,
        source: &Bound<'_, PyAny>,
        db: Py<Database>,
        trace_hook: PyObject,
        owner_idx: i32,
        attr: &str,
    ) -> PyResult<Self> {
        let collections = py.import("collections")?;
        let deque_type = collections.getattr("deque")?;
        let copy = deque_type.call1((source,))?;
        let len: usize = copy.len()?;
        let arws = std::collections::VecDeque::from(vec![AttrRecordWrite::new(0, 0); len]);
        Ok(Self {
            inner: copy.unbind(),
            arws,
            db,
            trace_hook,
            _tr_wrapped: true,
        })
    }

    fn __len__(&self, py: Python<'_>) -> PyResult<usize> {
        self.inner.bind(py).len()
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(format!("TracedDeque({})", self.inner.bind(py).repr()?))
    }

    fn __iter__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let iter = self.inner.bind(py).call_method0("__iter__")?;
        Ok(iter.unbind())
    }

    fn __getitem__(&self, py: Python<'_>, index: isize) -> PyResult<PyObject> {
        let result = self.inner.bind(py).call_method1("__getitem__", (index,))?;
        let len = self.arws.len();
        let idx = if index < 0 { (len as isize + index) as usize } else { index as usize };
        if idx < len {
            emit_read(py, &self.arws[idx]);
        }
        Ok(result.unbind())
    }

    fn __setitem__(&mut self, py: Python<'_>, index: isize, value: &Bound<'_, PyAny>) -> PyResult<()> {
        self.inner.bind(py).call_method1("__setitem__", (index, value))?;
        let len = self.arws.len();
        let idx = if index < 0 { (len as isize + index) as usize } else { index as usize };
        if idx < len {
            self.arws[idx] = caller_arw(py);
        }
        Ok(())
    }

    fn append(&mut self, py: Python<'_>, value: &Bound<'_, PyAny>) -> PyResult<()> {
        self.inner.bind(py).call_method1("append", (value,))?;
        self.arws.push_back(caller_arw(py));
        Ok(())
    }

    fn appendleft(&mut self, py: Python<'_>, value: &Bound<'_, PyAny>) -> PyResult<()> {
        self.inner.bind(py).call_method1("appendleft", (value,))?;
        self.arws.push_front(caller_arw(py));
        Ok(())
    }

    fn extend(&mut self, py: Python<'_>, values: &Bound<'_, PyAny>) -> PyResult<()> {
        let arw = caller_arw(py);
        let start: usize = self.inner.bind(py).len()?;
        self.inner.bind(py).call_method1("extend", (values,))?;
        let new_len: usize = self.inner.bind(py).len()?;
        for _ in start..new_len {
            self.arws.push_back(arw.clone());
        }
        Ok(())
    }

    fn extendleft(&mut self, py: Python<'_>, values: &Bound<'_, PyAny>) -> PyResult<()> {
        let arw = caller_arw(py);
        let start: usize = self.inner.bind(py).len()?;
        self.inner.bind(py).call_method1("extendleft", (values,))?;
        let new_len: usize = self.inner.bind(py).len()?;
        for _ in start..new_len {
            self.arws.push_front(arw.clone());
        }
        Ok(())
    }

    fn pop(&mut self, py: Python<'_>) -> PyResult<PyObject> {
        if let Some(arw) = self.arws.back() {
            emit_read(py, arw);
        }
        self.arws.pop_back();
        let result = self.inner.bind(py).call_method0("pop")?;
        Ok(result.unbind())
    }

    fn popleft(&mut self, py: Python<'_>) -> PyResult<PyObject> {
        if let Some(arw) = self.arws.front() {
            emit_read(py, arw);
        }
        self.arws.pop_front();
        let result = self.inner.bind(py).call_method0("popleft")?;
        Ok(result.unbind())
    }

    fn clear(&mut self, py: Python<'_>) -> PyResult<()> {
        self.inner.bind(py).call_method0("clear")?;
        self.arws.clear();
        Ok(())
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let collections = py.import("collections")?;
        let deque_type = collections.getattr("deque")?;
        let inner_list = self.inner.bind(py).call_method0("copy")?;
        let args = pyo3::types::PyTuple::new(py, &[inner_list.as_any()])?;
        let result = pyo3::types::PyTuple::new(py, &[deque_type.as_any(), args.as_any()])?;
        Ok(result.unbind().into())
    }
}

// ---------------------------------------------------------------------------
// wrap_container
// ---------------------------------------------------------------------------

pub fn wrap_container_inner(
    py: Python<'_>,
    value: &Bound<'_, PyAny>,
    db: Py<Database>,
    trace_hook: PyObject,
    owner_idx: i32,
    attr: &str,
) -> PyResult<Option<PyObject>> {
    let value_type = value.get_type();
    let type_name = value_type.qualname()?.to_string();

    let dict_type = py.get_type::<PyDict>();
    let list_type = py.get_type::<PyList>();

    if value_type.is(&dict_type) {
        let dict: &Bound<'_, PyDict> = value.downcast()?;
        let traced = TracedDict::new(py, dict, db, trace_hook, owner_idx, attr)?;
        return Ok(Some(traced.into_pyobject(py)?.into_any().unbind()));
    }

    if value_type.is(&list_type) {
        let list: &Bound<'_, PyList> = value.downcast()?;
        let traced = TracedList::new(py, list, db, trace_hook, owner_idx, attr)?;
        return Ok(Some(traced.into_pyobject(py)?.into_any().unbind()));
    }

    if type_name == "deque" {
        let traced = TracedDeque::new(py, value, db, trace_hook, owner_idx, attr)?;
        return Ok(Some(traced.into_pyobject(py)?.into_any().unbind()));
    }

    Ok(None)
}

#[pyfunction]
#[pyo3(signature = (value, db, trace_hook, owner_idx, attr))]
pub fn wrap_container(
    py: Python<'_>,
    value: &Bound<'_, PyAny>,
    db: Py<Database>,
    trace_hook: PyObject,
    owner_idx: i32,
    attr: &str,
) -> PyResult<Option<PyObject>> {
    wrap_container_inner(py, value, db, trace_hook, owner_idx, attr)
}
