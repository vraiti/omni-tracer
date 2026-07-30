use pyo3::prelude::*;
use pyo3::types::{PyList, PyString, PyType};
use std::collections::{HashMap, HashSet};

#[pyclass(module = "tracer._tracer")]
pub struct PathFilter {
    pub prefixes: Vec<String>,
    pub tracked_classes: HashSet<String>,
    scope_cache: HashMap<usize, bool>,
}

#[pymethods]
impl PathFilter {
    #[new]
    #[pyo3(signature = (prefixes=None, tracked_file=None))]
    pub fn new(py: Python<'_>, prefixes: Option<Vec<String>>, tracked_file: Option<&str>) -> PyResult<Self> {
        let prefixes = if let Some(p) = prefixes {
            p
        } else {
            let mut auto = Vec::new();
            for pkg in &["vllm_omni", "vllm"] {
                let result = py.import(pkg);
                if let Ok(module) = result {
                    if let Ok(path) = module.getattr("__path__") {
                        let path_list: Vec<String> = path.extract()?;
                        auto.extend(path_list);
                    } else if let Ok(file) = module.getattr("__file__") {
                        let file_str: String = file.extract()?;
                        if let Some(dir) = file_str.rsplit_once('/') {
                            auto.push(dir.0.to_string());
                        }
                    }
                }
            }
            auto
        };

        let mut tracked_classes = HashSet::new();
        if let Some(path) = tracked_file {
            let content = std::fs::read_to_string(path)?;
            for line in content.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    tracked_classes.insert(trimmed.to_string());
                }
            }
        }

        Ok(Self {
            prefixes,
            tracked_classes,
            scope_cache: HashMap::new(),
        })
    }

    #[getter]
    pub fn _prefixes(&self, py: Python<'_>) -> PyResult<Py<PyList>> {
        let list = PyList::empty(py);
        for p in &self.prefixes {
            list.append(PyString::new(py, p))?;
        }
        Ok(list.unbind())
    }

    pub fn is_in_scope(&mut self, filename: &Bound<'_, PyString>) -> bool {
        let ptr = filename.as_ptr() as usize;
        if let Some(&cached) = self.scope_cache.get(&ptr) {
            return cached;
        }
        let fname = filename.to_str().unwrap_or("");
        let result = self.prefixes.iter().any(|p| fname.starts_with(p));
        self.scope_cache.insert(ptr, result);
        result
    }

    pub fn is_tracked_class(&self, cls: &Bound<'_, PyType>) -> bool {
        let module = cls.getattr("__module__")
            .and_then(|m| m.extract::<String>())
            .unwrap_or_default();
        let qualname = cls.getattr("__qualname__")
            .and_then(|q| q.extract::<String>())
            .unwrap_or_default();
        let full = format!("{}.{}", module, qualname);
        self.tracked_classes.contains(&full)
    }
}

impl PathFilter {
    pub fn check_scope_fast(&mut self, filename_ptr: usize, filename: &str) -> bool {
        if let Some(&cached) = self.scope_cache.get(&filename_ptr) {
            return cached;
        }
        let result = self.prefixes.iter().any(|p| filename.starts_with(p));
        self.scope_cache.insert(filename_ptr, result);
        result
    }
}
