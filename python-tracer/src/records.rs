use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyDict, PyList};
use std::sync::Mutex;

#[pyclass(module = "tracer._tracer")]
#[derive(Clone)]
pub struct AttrRecordWrite {
    #[pyo3(get)]
    pub caller_id: u64,
    #[pyo3(get)]
    pub call_lineno: i32,
}

#[pymethods]
impl AttrRecordWrite {
    #[new]
    pub fn new(caller_id: u64, call_lineno: i32) -> Self {
        Self { caller_id, call_lineno }
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let cls = py.import("tracer._tracer")?.getattr("AttrRecordWrite")?;
        let args = pyo3::types::PyTuple::new(py, &[self.caller_id.into_pyobject(py)?.into_any(), self.call_lineno.into_pyobject(py)?.into_any()])?;
        let result = pyo3::types::PyTuple::new(py, &[cls.as_any(), args.as_any()])?;
        Ok(result.unbind().into())
    }
}

#[pyclass(module = "tracer._tracer")]
#[derive(Clone)]
pub struct AttrRecordRead {
    #[pyo3(get)]
    pub caller_id: u64,
    #[pyo3(get)]
    pub write_call_lineno: i32,
    #[pyo3(get)]
    pub read_call_lineno: i32,
}

#[pymethods]
impl AttrRecordRead {
    #[new]
    pub fn new(caller_id: u64, write_call_lineno: i32, read_call_lineno: i32) -> Self {
        Self { caller_id, write_call_lineno, read_call_lineno }
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let cls = py.import("tracer._tracer")?.getattr("AttrRecordRead")?;
        let args = pyo3::types::PyTuple::new(py, &[
            self.caller_id.into_pyobject(py)?.into_any(),
            self.write_call_lineno.into_pyobject(py)?.into_any(),
            self.read_call_lineno.into_pyobject(py)?.into_any(),
        ])?;
        Ok(pyo3::types::PyTuple::new(py, &[cls.as_any(), args.as_any()])?.unbind().into())
    }
}

#[pyclass(module = "tracer._tracer")]
pub struct CallRecord {
    #[pyo3(get)]
    pub call_id: u64,
    #[pyo3(get)]
    pub function_id: i32,
    #[pyo3(get)]
    pub caller_id: u64,
    #[pyo3(get)]
    pub call_lineno: i32,
    #[pyo3(get, set)]
    pub obj_id: i32,
    #[pyo3(get, set)]
    pub control_flow: Py<PyByteArray>,
    #[pyo3(get)]
    pub attr_reads: Py<PyList>,
}

#[pymethods]
impl CallRecord {
    #[new]
    pub fn new(
        py: Python<'_>,
        call_id: u64,
        function_id: i32,
        caller_id: u64,
        call_lineno: i32,
        obj_id: i32,
    ) -> Self {
        Self {
            call_id,
            function_id,
            caller_id,
            call_lineno,
            obj_id,
            control_flow: PyByteArray::new(py, &[]).unbind(),
            attr_reads: PyList::empty(py).unbind(),
        }
    }

    pub fn append_branch(&self, py: Python<'_>, taken: bool) {
        let ba = self.control_flow.bind(py);
        let byte = if taken { 1u8 } else { 0u8 };
        ba.resize(ba.len() + 1).unwrap();
        unsafe {
            *ba.as_bytes_mut().last_mut().unwrap() = byte;
        }
    }

    pub fn append_attr_read(&self, py: Python<'_>, read: AttrRecordRead) -> PyResult<()> {
        self.attr_reads.bind(py).append(read.into_pyobject(py)?)?;
        Ok(())
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let cls = py.import("tracer._tracer")?.getattr("CallRecord")?;
        let args = pyo3::types::PyTuple::new(py, &[
            self.call_id.into_pyobject(py)?.into_any(),
            self.function_id.into_pyobject(py)?.into_any(),
            self.caller_id.into_pyobject(py)?.into_any(),
            self.call_lineno.into_pyobject(py)?.into_any(),
            self.obj_id.into_pyobject(py)?.into_any(),
        ])?;
        Ok(pyo3::types::PyTuple::new(py, &[cls.as_any(), args.as_any()])?.unbind().into())
    }
}

#[pyclass(module = "tracer._tracer")]
pub struct ObjectRecord {
    #[pyo3(get)]
    pub call_id: u64,
    #[pyo3(get)]
    pub members: Py<PyDict>,
}

#[pymethods]
impl ObjectRecord {
    #[new]
    pub fn new(py: Python<'_>, call_id: u64) -> Self {
        Self {
            call_id,
            members: PyDict::new(py).unbind(),
        }
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let cls = py.import("tracer._tracer")?.getattr("ObjectRecord")?;
        let args = pyo3::types::PyTuple::new(py, &[
            self.call_id.into_pyobject(py)?.into_any(),
        ])?;
        Ok(pyo3::types::PyTuple::new(py, &[cls.as_any(), args.as_any()])?.unbind().into())
    }
}

#[pyclass(module = "tracer._tracer")]
pub struct IpcRecord {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub obj_idx: i64,
}

#[pymethods]
impl IpcRecord {
    #[new]
    pub fn new(name: String, obj_idx: i64) -> Self {
        Self { name, obj_idx }
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let cls = py.import("tracer._tracer")?.getattr("IpcRecord")?;
        let args = pyo3::types::PyTuple::new(py, &[
            self.name.clone().into_pyobject(py)?.into_any(),
            self.obj_idx.into_pyobject(py)?.into_any(),
        ])?;
        Ok(pyo3::types::PyTuple::new(py, &[cls.as_any(), args.as_any()])?.unbind().into())
    }
}

#[pyclass(module = "tracer._tracer")]
pub struct Database {
    #[pyo3(get)]
    pub calls: Py<PyList>,
    #[pyo3(get)]
    pub objects: Py<PyList>,
    #[pyo3(get)]
    pub ipc: Py<PyList>,
    lock: Mutex<()>,
}

#[pymethods]
impl Database {
    #[new]
    pub fn new(py: Python<'_>) -> Self {
        Self {
            calls: PyList::empty(py).unbind(),
            objects: PyList::empty(py).unbind(),
            ipc: PyList::empty(py).unbind(),
            lock: Mutex::new(()),
        }
    }

    pub fn add_call(&self, py: Python<'_>, rec: Py<CallRecord>) -> PyResult<usize> {
        let _guard = self.lock.lock().unwrap();
        let list = self.calls.bind(py);
        let idx = list.len();
        list.append(rec)?;
        Ok(idx)
    }

    pub fn add_object(&self, py: Python<'_>, rec: Py<ObjectRecord>) -> PyResult<usize> {
        let _guard = self.lock.lock().unwrap();
        let list = self.objects.bind(py);
        let idx = list.len();
        list.append(rec)?;
        Ok(idx)
    }

    pub fn add_ipc(&self, py: Python<'_>, rec: Py<IpcRecord>) -> PyResult<usize> {
        let _guard = self.lock.lock().unwrap();
        let list = self.ipc.bind(py);
        let idx = list.len();
        list.append(rec)?;
        Ok(idx)
    }

    fn __reduce__(&self, py: Python<'_>) -> PyResult<PyObject> {
        let cls = py.import("tracer._tracer")?.getattr("Database")?;
        let args = pyo3::types::PyTuple::empty(py);
        Ok(pyo3::types::PyTuple::new(py, &[cls.as_any(), args.as_any()])?.unbind().into())
    }
}
