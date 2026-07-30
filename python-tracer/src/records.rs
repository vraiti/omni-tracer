use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyDict, PyList};
use std::sync::Mutex;

#[pyclass]
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
}

#[pyclass]
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
}

#[pyclass]
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
}

#[pyclass]
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
}

#[pyclass]
pub struct IpcRecord {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub obj_idx: i32,
}

#[pymethods]
impl IpcRecord {
    #[new]
    pub fn new(name: String, obj_idx: i32) -> Self {
        Self { name, obj_idx }
    }
}

#[pyclass]
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
}
