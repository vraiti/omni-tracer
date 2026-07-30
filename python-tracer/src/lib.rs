mod frame;
mod records;
mod filter;
mod hook;
mod ownership;
mod containers;

use pyo3::prelude::*;

#[pymodule]
fn _tracer(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<records::AttrRecordWrite>()?;
    m.add_class::<records::AttrRecordRead>()?;
    m.add_class::<records::CallRecord>()?;
    m.add_class::<records::ObjectRecord>()?;
    m.add_class::<records::IpcRecord>()?;
    m.add_class::<records::Database>()?;
    m.add_class::<filter::PathFilter>()?;
    m.add_class::<ownership::OwnershipHook>()?;
    m.add_class::<ownership::TracedSetattr>()?;
    m.add_class::<ownership::TracedGetattr>()?;
    m.add_class::<ownership::BoundSetattr>()?;
    m.add_class::<ownership::BoundGetattr>()?;
    m.add_class::<containers::TracedDict>()?;
    m.add_class::<containers::TracedList>()?;
    m.add_class::<containers::TracedDeque>()?;
    m.add_function(wrap_pyfunction!(hook::install, m)?)?;
    m.add_function(wrap_pyfunction!(hook::install_thread, m)?)?;
    m.add_function(wrap_pyfunction!(hook::uninstall, m)?)?;
    m.add_function(wrap_pyfunction!(hook::get_call_id, m)?)?;
    m.add_function(wrap_pyfunction!(hook::set_call_id, m)?)?;
    m.add_function(wrap_pyfunction!(hook::current_record, m)?)?;
    m.add_function(wrap_pyfunction!(containers::wrap_container, m)?)?;
    Ok(())
}
