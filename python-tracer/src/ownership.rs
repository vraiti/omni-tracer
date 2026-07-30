use pyo3::prelude::*;
use pyo3::types::{PyString, PyType};
use std::collections::HashSet;

use crate::containers;
use crate::frame;
use crate::hook;
use crate::records::{AttrRecordRead, AttrRecordWrite, Database};

#[pyclass]
pub struct OwnershipHook {
    db: Py<Database>,
    trace_hook: PyObject,
    patched_classes: HashSet<usize>,
}

#[pymethods]
impl OwnershipHook {
    #[new]
    pub fn new(db: Py<Database>, trace_hook: PyObject) -> Self {
        Self {
            db,
            trace_hook,
            patched_classes: HashSet::new(),
        }
    }

    pub fn patch_class(&mut self, py: Python<'_>, cls: &Bound<'_, PyType>) -> PyResult<()> {
        let cls_id = cls.as_ptr() as usize;
        if self.patched_classes.contains(&cls_id) {
            return Ok(());
        }
        self.patched_classes.insert(cls_id);

        let original_setattr = cls.getattr("__setattr__")?;
        let original_getattr = if cls.hasattr("__getattribute__")? {
            cls.getattr("__getattribute__")?
        } else {
            py.import("builtins")?.getattr("object")?.getattr("__getattribute__")?.unbind().into_bound(py)
        };

        let traced_set = TracedSetattr {
            original: original_setattr.unbind(),
            db: self.db.clone_ref(py),
            trace_hook: self.trace_hook.clone_ref(py),
        };
        let traced_get = TracedGetattr {
            original: original_getattr.unbind(),
            trace_hook: self.trace_hook.clone_ref(py),
        };

        cls.setattr("__setattr__", traced_set.into_pyobject(py)?)?;
        cls.setattr("__getattribute__", traced_get.into_pyobject(py)?)?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// TracedSetattr — descriptor that replaces cls.__setattr__
// ---------------------------------------------------------------------------

#[pyclass]
pub struct TracedSetattr {
    original: PyObject,
    db: Py<Database>,
    trace_hook: PyObject,
}

#[pymethods]
impl TracedSetattr {
    fn __get__<'py>(
        slf: &Bound<'py, Self>,
        obj: &Bound<'py, PyAny>,
        _cls: Option<&Bound<'py, PyType>>,
    ) -> PyResult<PyObject> {
        if obj.is_none() {
            return Ok(slf.clone().into_any().unbind());
        }
        let py = slf.py();
        let bound = BoundSetattr {
            inner: slf.clone().unbind(),
            instance: obj.clone().unbind(),
        };
        Ok(bound.into_pyobject(py)?.into_any().unbind())
    }

    pub fn call_impl(
        &self,
        py: Python<'_>,
        self_obj: &Bound<'_, PyAny>,
        name: &Bound<'_, PyString>,
        value: &Bound<'_, PyAny>,
    ) -> PyResult<PyObject> {
        let name_str = name.to_str()?;

        if name_str.starts_with("__tr_") || name_str.starts_with("__arw_") {
            let object = py.import("builtins")?.getattr("object")?;
            object.call_method1("__setattr__", (self_obj, name, value))?;
            return Ok(py.None());
        }

        self.original.call1(py, (self_obj, name, value))?;

        let frame_ptr = unsafe { pyo3::ffi::PyEval_GetFrame() };
        if frame_ptr.is_null() {
            return Ok(py.None());
        }
        let caller_id = unsafe { frame::get_call_id(frame_ptr as *mut pyo3::ffi::PyObject) };
        let call_lineno = unsafe { pyo3::ffi::PyFrame_GetLineNumber(frame_ptr) };

        let arw = AttrRecordWrite::new(caller_id, call_lineno);
        let arw_key = format!("__arw_{}", name_str);
        let builtins_setattr = py.import("builtins")?.getattr("object")?.getattr("__setattr__")?;
        builtins_setattr.call1((self_obj, arw_key, arw.clone().into_pyobject(py)?))?;

        let obj_idx = self_obj
            .getattr("__tr_idx")
            .and_then(|v| v.extract::<i32>())
            .ok();

        if let Some(idx) = obj_idx {
            if let Ok(val_idx) = value.getattr("__tr_idx").and_then(|v| v.extract::<i32>()) {
                let db = self.db.bind(py);
                let objects = db.getattr("objects")?;
                let obj_rec = objects.get_item(idx)?;
                let members = obj_rec.getattr("members")?;
                members.set_item(name, val_idx)?;
            }
        }

        let value_type = value.get_type();
        let dict_type = py.get_type::<pyo3::types::PyDict>();
        let list_type = py.get_type::<pyo3::types::PyList>();

        let is_container = value_type.is(&dict_type)
            || value_type.is(&list_type)
            || value_type.qualname()?.to_str()? == "deque";
        let is_wrapped = value
            .getattr("_tr_wrapped")
            .and_then(|v| v.extract::<bool>())
            .unwrap_or(false);

        if is_container && !is_wrapped {
            let wrapped = containers::wrap_container_inner(
                py,
                value,
                self.db.clone_ref(py),
                self.trace_hook.clone_ref(py),
                obj_idx.unwrap_or(-1),
                name_str,
            )?;
            if let Some(w) = wrapped {
                builtins_setattr.call1((self_obj, name, w))?;
            }
        }

        Ok(py.None())
    }
}

#[pyclass]
pub struct BoundSetattr {
    inner: Py<TracedSetattr>,
    instance: PyObject,
}

#[pymethods]
impl BoundSetattr {
    #[pyo3(signature = (name, value))]
    fn __call__(
        &self,
        py: Python<'_>,
        name: &Bound<'_, PyString>,
        value: &Bound<'_, PyAny>,
    ) -> PyResult<PyObject> {
        let instance = self.instance.bind(py);
        self.inner.borrow(py).call_impl(py, instance, name, value)
    }
}

// ---------------------------------------------------------------------------
// TracedGetattr — descriptor that replaces cls.__getattribute__
// ---------------------------------------------------------------------------

#[pyclass]
pub struct TracedGetattr {
    original: PyObject,
    trace_hook: PyObject,
}

#[pymethods]
impl TracedGetattr {
    fn __get__<'py>(
        slf: &Bound<'py, Self>,
        obj: &Bound<'py, PyAny>,
        _cls: Option<&Bound<'py, PyType>>,
    ) -> PyResult<PyObject> {
        if obj.is_none() {
            return Ok(slf.clone().into_any().unbind());
        }
        let py = slf.py();
        let bound = BoundGetattr {
            inner: slf.clone().unbind(),
            instance: obj.clone().unbind(),
        };
        Ok(bound.into_pyobject(py)?.into_any().unbind())
    }

    pub fn call_impl(
        &self,
        py: Python<'_>,
        self_obj: &Bound<'_, PyAny>,
        name: &Bound<'_, PyString>,
    ) -> PyResult<PyObject> {
        let value = self.original.call1(py, (self_obj, name))?;

        let name_str = name.to_str()?;
        if name_str.starts_with("__") {
            return Ok(value);
        }

        let arw_key = format!("__arw_{}", name_str);
        let arw = self
            .original
            .call1(py, (self_obj, arw_key))
            .ok()
            .and_then(|obj| obj.extract::<AttrRecordWrite>(py).ok());

        if let Some(arw) = arw {
            let frame_ptr = unsafe { pyo3::ffi::PyEval_GetFrame() };
            if !frame_ptr.is_null() {
                let caller_id =
                    unsafe { frame::get_call_id(frame_ptr as *mut pyo3::ffi::PyObject) };
                let read_lineno = unsafe { pyo3::ffi::PyFrame_GetLineNumber(frame_ptr) };

                if let Some(rec) = hook::current_record(py) {
                    let record = rec.bind(py);
                    let attr_reads = record.getattr("attr_reads")?;
                    let read = AttrRecordRead::new(
                        caller_id,
                        arw.call_lineno,
                        read_lineno,
                    );
                    attr_reads.call_method1("append", (read.into_pyobject(py)?,))?;
                }
            }
        }

        Ok(value)
    }
}

#[pyclass]
pub struct BoundGetattr {
    inner: Py<TracedGetattr>,
    instance: PyObject,
}

#[pymethods]
impl BoundGetattr {
    #[pyo3(signature = (name,))]
    fn __call__(
        &self,
        py: Python<'_>,
        name: &Bound<'_, PyString>,
    ) -> PyResult<PyObject> {
        let instance = self.instance.bind(py);
        self.inner.borrow(py).call_impl(py, instance, name)
    }
}
